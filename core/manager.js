const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const NodeCache = require('node-cache');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const { supabaseAdmin } = require('../auth/supabase');
const { createUserBot } = require('./userBot');
const { getSettings } = require('../utils/db');

const instances = new Map();

// Cache compartido para reintentos de mensajes (requerido por Baileys)
const msgRetryCounterCache = new NodeCache();

// 🔍 DIAGNÓSTICO: Verificar valores reales de DisconnectReason en esta versión de Baileys
console.log('🔍 DisconnectReason.loggedOut =', DisconnectReason.loggedOut);
console.log('🔍 DisconnectReason completo =', JSON.stringify(DisconnectReason));

// Directorio base para las sesiones
const AUTH_DIR = path.join(__dirname, '..', 'auth_states');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

async function startUserInstance(userId, phoneNumber) {
  const cleanPhone = String(phoneNumber).replace(/\D/g, '');
  console.log(`[User ${userId}] 🚀 Iniciando instancia para ${cleanPhone} (${cleanPhone.length} dígitos)`);

  // Cerrar instancia previa completamente antes de crear una nueva
  const existing = instances.get(userId);
  if (existing) {
    if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
    if (existing.pairingTimer) clearTimeout(existing.pairingTimer);
    try { existing.sock?.end(undefined); } catch (e) {}
    instances.delete(userId);
    // Pequeña pausa para que el socket anterior cierre limpiamente
    await new Promise(r => setTimeout(r, 1000));
  }

  const sessionDir = path.join(AUTH_DIR, userId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[User ${userId}] 📦 Baileys version: ${version.join('.')}`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    mobile: false,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, pino({ level: 'silent' })),
    },
    msgRetryCounterCache,
    generateHighQualityLinkPreview: true,
    defaultQueryTimeoutMs: undefined,
  });

  const instanceState = {
    userId,
    phoneNumber: cleanPhone,
    status: 'connecting',
    sock,
    qrBase64: null,
    pairingCode: null,
    pairingCodeRequestedAt: null,
    isConnected: false,
    reconnectTimer: null,
    pairingTimer: null,
  };
  instances.set(userId, instanceState);

  const userBot = createUserBot(userId, sock);

  sock.ev.on('creds.update', () => saveCreds());

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const inst = instances.get(userId);
    if (!inst) return;

    console.log(`[User ${userId}] 📡 connection.update: connection=${connection}, qr=${!!qr}`);

    // Guardar QR como respaldo visual si llega, pero NO pedir código aquí
    if (qr) {
      try {
        inst.qrBase64 = await QRCode.toDataURL(qr);
      } catch (_) {}
    }

    if (connection === 'open') {
      inst.isConnected = true;
      inst.qrBase64 = null;
      inst.pairingCode = null;
      inst.status = 'connected';
      console.log(`[User ${userId}] ✅ Conectado a WhatsApp`);

      const settings = await getSettings(userId);
      if (!settings) {
        console.log(`[User ${userId}] 📝 Creando configuración por defecto`);
        const defaultSettings = {
          autoReply: { active: false, text: 'Estoy fuera de servicio', startHour: 23, endHour: 8 },
          tasks: [],
          statusTasks: [],
        };
        await supabaseAdmin.from('bot_settings').insert({ user_id: userId, data: defaultSettings });
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message || 'sin mensaje';
      const errorOutput = lastDisconnect?.error?.output || {};
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`[User ${userId}] ❌ Conexión cerrada.`);
      console.log(`[User ${userId}]    statusCode=${statusCode}`);
      console.log(`[User ${userId}]    isLoggedOut=${isLoggedOut} (DisconnectReason.loggedOut=${DisconnectReason.loggedOut})`);
      console.log(`[User ${userId}]    errorMessage=${errorMessage}`);
      console.log(`[User ${userId}]    errorOutput=${JSON.stringify(errorOutput)}`);
      console.log(`[User ${userId}]    inst.isConnected al cerrar=${inst.isConnected}`);

      inst.isConnected = false;
      inst.status = 'disconnected';

      if (isLoggedOut) {
        console.log(`[User ${userId}] 🗑️ Logout explícito. Eliminando sesión.`);
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      } else {
        console.log(`[User ${userId}] 🔄 Reconectando en 5s...`);
        inst.reconnectTimer = setTimeout(() => {
          reconnectUserInstance(userId, cleanPhone, sessionDir);
        }, 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    await userBot.handleMessages(messages);
  });

  // Pedir código de emparejamiento tras conectar el socket (3s de espera para que se estabilice)
  if (!authState.creds.registered) {
    instanceState.status = 'qr_pending';

    const requestPairingCodeWithRetry = async (attempt = 1) => {
      const inst = instances.get(userId);
      if (!inst || inst.isConnected) return;

      try {
        console.log(`[User ${userId}] 🔑 Solicitando código de emparejamiento para +${cleanPhone} (intento ${attempt})...`);
        inst.status = 'requesting_code';

        const code = await sock.requestPairingCode(cleanPhone);
        console.log(`[User ${userId}]    Respuesta raw de Baileys: ${code}`);

        const formattedCode = code?.match(/.{1,4}/g)?.join('-') ?? code;
        inst.pairingCode = formattedCode;
        inst.pairingCodeRequestedAt = Date.now();
        inst.status = 'pairing';
        console.log(`[User ${userId}] ✅ Código de emparejamiento listo: ${formattedCode}`);
      } catch (err) {
        console.error(`[User ${userId}] ❌ Error pidiendo código (intento ${attempt}):`, err?.message || err);

        const inst = instances.get(userId);
        if (inst && !inst.isConnected && attempt < 3) {
          console.log(`[User ${userId}] 🔄 Reintentando en 5s...`);
          inst.pairingTimer = setTimeout(() => requestPairingCodeWithRetry(attempt + 1), 5000);
        } else if (inst) {
          inst.status = 'error';
          inst.pairingCode = null;
          console.error(`[User ${userId}] ❌ No se pudo obtener el código tras ${attempt} intentos.`);
        }
      }
    };

    instanceState.pairingTimer = setTimeout(() => requestPairingCodeWithRetry(1), 3000);
  }

  return sock;
}

// 🔥 Reconexión usando sesión existente (sin pedir nuevo código)
async function reconnectUserInstance(userId, cleanPhone, sessionDir) {
  const existing = instances.get(userId);
  if (existing?.isConnected || existing?.status === 'connecting') return;

  console.log(`[User ${userId}] 🔄 Reconectando con sesión existente...`);

  const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, pino({ level: 'silent' })),
    },
    msgRetryCounterCache,
    defaultQueryTimeoutMs: undefined,
  });

  const inst = instances.get(userId);
  if (inst) {
    inst.sock = sock;
    inst.status = 'connecting';
  }

  sock.ev.on('creds.update', () => saveCreds());

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    const inst = instances.get(userId);
    if (!inst) return;

    console.log(`[User ${userId}] 📡 [reconexión] connection=${connection}`);

    if (connection === 'open') {
      inst.isConnected = true;
      inst.status = 'connected';
      inst.pairingCode = null;
      console.log(`[User ${userId}] ✅ Reconectado a WhatsApp`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`[User ${userId}] ❌ [reconexión] Cerrado. statusCode=${statusCode}`);
      inst.isConnected = false;
      inst.status = 'disconnected';

      if (isLoggedOut) {
        console.log(`[User ${userId}] 🗑️ Logout. Eliminando sesión.`);
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      } else {
        inst.reconnectTimer = setTimeout(() => {
          reconnectUserInstance(userId, cleanPhone, sessionDir);
        }, 5000);
      }
    }
  });

  const userBot = createUserBot(userId, sock);
  sock.ev.on('messages.upsert', async ({ messages }) => {
    await userBot.handleMessages(messages);
  });
}

async function initManager() {
  console.log('👥 Manager inicializado. Las conexiones se establecerán bajo demanda.');
}

async function stopUserInstance(userId) {
  const instance = instances.get(userId);
  if (instance) {
    if (instance.reconnectTimer) clearTimeout(instance.reconnectTimer);
    if (instance.pairingTimer) clearTimeout(instance.pairingTimer);
    try {
      instance.sock?.end(undefined);
    } catch (e) {}
    instances.delete(userId);
  }
}

function getUserStatus(userId) {
  const instance = instances.get(userId);
  if (!instance) return null;
  return {
    connected: instance.isConnected,
    qr: instance.qrBase64,
    pairingCode: instance.pairingCode,
    pairingCodeRequestedAt: instance.pairingCodeRequestedAt,
    phoneNumber: instance.phoneNumber,
    status: instance.status,
  };
}

function getAllInstances() {
  const result = [];
  for (const [userId, instance] of instances.entries()) {
    result.push({
      userId,
      phoneNumber: instance.phoneNumber,
      connected: instance.isConnected,
      hasQR: !!instance.qrBase64,
    });
  }
  return result;
}

async function startUserIfApproved(userId) {
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('phone_number, is_approved')
    .eq('id', userId)
    .single();

  if (profile && profile.is_approved) {
    await stopUserInstance(userId);
    return startUserInstance(userId, profile.phone_number);
  }
  return null;
}

async function getGroupsForUser(userId) {
  const instance = instances.get(userId);
  if (!instance || !instance.isConnected) return [];
  try {
    const groups = await instance.sock.groupFetchAllParticipating();
    return Object.entries(groups).map(([id, info]) => ({ id, name: info.subject }));
  } catch (e) {
    console.error(`Error fetching groups for user ${userId}:`, e);
    return [];
  }
}

async function clearUserSession(userId) {
  const instance = instances.get(userId);
  if (instance) {
    if (instance.reconnectTimer) clearTimeout(instance.reconnectTimer);
    try {
      await instance.sock?.logout();
    } catch (e) {}
    await stopUserInstance(userId);
  }
  const sessionDir = path.join(AUTH_DIR, userId);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  console.log(`[User ${userId}] Sesión eliminada completamente.`);
  return true;
}

// Elimina TODAS las sesiones guardadas en disco y detiene todas las instancias
async function clearAllSessions() {
  console.log('🧹 Eliminando TODAS las sesiones...');

  const userIds = [...instances.keys()];
  for (const userId of userIds) {
    const instance = instances.get(userId);
    if (instance) {
      if (instance.reconnectTimer) clearTimeout(instance.reconnectTimer);
      if (instance.pairingTimer) clearTimeout(instance.pairingTimer);
      try { instance.sock?.end(undefined); } catch (e) {}
    }
  }
  instances.clear();
  console.log(`🛑 ${userIds.length} instancia(s) detenida(s).`);

  let deletedCount = 0;
  if (fs.existsSync(AUTH_DIR)) {
    const entries = fs.readdirSync(AUTH_DIR);
    for (const entry of entries) {
      const entryPath = path.join(AUTH_DIR, entry);
      try {
        fs.rmSync(entryPath, { recursive: true, force: true });
        deletedCount++;
        console.log(`🗑️ Sesión eliminada: ${entry}`);
      } catch (e) {
        console.error(`❌ Error eliminando sesión ${entry}:`, e.message);
      }
    }
  }

  console.log(`✅ Limpieza completa. ${deletedCount} sesión(es) eliminada(s) del disco.`);
  return { stopped: userIds.length, deleted: deletedCount };
}

module.exports = {
  startUserInstance,
  stopUserInstance,
  getUserStatus,
  getAllInstances,
  initManager,
  startUserIfApproved,
  getGroupsForUser,
  clearUserSession,
  clearAllSessions,
  instances,
};
