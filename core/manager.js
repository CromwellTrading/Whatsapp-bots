const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const { supabaseAdmin } = require('../auth/supabase');
const { createUserBot } = require('./userBot');
const { getSettings } = require('../utils/db');

const instances = new Map();

// Directorio base para las sesiones
const AUTH_DIR = path.join(__dirname, '..', 'auth_states');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

async function startUserInstance(userId, phoneNumber) {
  const cleanPhone = String(phoneNumber).replace(/\D/g, '');

  // 🔥 Log del número para verificar formato (código de país + número)
  console.log(`[User ${userId}] 🚀 Iniciando instancia para ${cleanPhone} (${cleanPhone.length} dígitos)`);

  // Cancelar timer previo si existe
  const existing = instances.get(userId);
  if (existing?.reconnectTimer) {
    clearTimeout(existing.reconnectTimer);
  }

  // Usar sistema de archivos para la sesión (carpeta por usuario)
  const sessionDir = path.join(AUTH_DIR, userId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[User ${userId}] 📦 Baileys version: ${version.join('.')}`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, pino({ level: 'silent' })),
    },
    // 🔥 Firma de Mac OS para evitar el filtro antispam de Meta
    browser: ['Mac OS', 'Safari', '10.15.7'],
    markOnlineOnConnect: true,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  });

  const instanceState = {
    userId,
    phoneNumber: cleanPhone,
    status: 'connecting',
    sock,
    qrBase64: null,
    pairingCode: null,
    isConnected: false,
    reconnectTimer: null,
  };
  instances.set(userId, instanceState);

  const userBot = createUserBot(userId, sock);

  // Flag para pedir el código solo una vez por sesión
  let pairingCodeRequested = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const inst = instances.get(userId);
    if (!inst) return;

    console.log(`[User ${userId}] 📡 connection.update: connection=${connection}, qr=${!!qr}`);

    // 🔥 FLUJO CORREGIDO: Pedir pairing code en el primer evento QR.
    // QR y pairing code son flujos mutuamente excluyentes en WhatsApp.
    // Si se pide tarde (múltiples updates de QR), WA no envía la notificación al dispositivo.
    if (qr && !pairingCodeRequested && !authState.creds.registered) {
      pairingCodeRequested = true;
      inst.qrBase64 = await QRCode.toDataURL(qr);
      inst.status = 'qr_pending';

      console.log(`[User ${userId}] 🖼️ Primer QR recibido. Solicitando código de emparejamiento...`);

      // Pequeño delay para que el WebSocket de WhatsApp esté completamente listo
      await new Promise(res => setTimeout(res, 2000));

      try {
        const code = await sock.requestPairingCode(cleanPhone);
        // Formatear el código como XXXX-XXXX para mejor legibilidad
        inst.pairingCode = code?.match(/.{1,4}/g)?.join('-') ?? code;
        console.log(`[User ${userId}] ✅ Código de emparejamiento obtenido: ${inst.pairingCode}`);
      } catch (err) {
        console.error(`[User ${userId}] ❌ Error pidiendo código de emparejamiento:`, err?.message || err);
      }

      return;
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
          statusTasks: []
        };
        await supabaseAdmin.from('bot_settings').insert({ user_id: userId, data: defaultSettings });
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      // 🔥 LÓGICA CORREGIDA DE RECONEXIÓN:
      // - loggedOut (515): el usuario cerró sesión desde WhatsApp → borrar sesión, no reconectar
      // - 401 sin haber conectado: el código de emparejamiento expiró → limpiar sesión y reintentar
      // - 401 habiendo conectado antes: sesión revocada → borrar sesión, no reconectar
      // - Cualquier otro error → reintentar
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isPairingExpired = statusCode === 401 && !inst.isConnected;
      const isSessionRevoked = statusCode === 401 && inst.isConnected;

      const shouldReconnect = !isLoggedOut && !isSessionRevoked;

      console.log(`[User ${userId}] ❌ Conexión cerrada. statusCode=${statusCode}, isLoggedOut=${isLoggedOut}, isPairingExpired=${isPairingExpired}, shouldReconnect=${shouldReconnect}`);

      inst.isConnected = false;
      inst.status = 'disconnected';
      pairingCodeRequested = false;

      if (isLoggedOut || isSessionRevoked) {
        // Logout explícito o sesión revocada → borrar sesión
        console.log(`[User ${userId}] 🗑️ Sesión inválida o cerrada. Eliminando archivos de sesión.`);
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      } else if (shouldReconnect) {
        const delay = isPairingExpired ? 5000 : 10000;

        if (isPairingExpired) {
          // 🔥 Limpiar sesión corrupta/expirada antes de reintentar
          // para que el próximo intento arranque limpio y genere un QR nuevo
          console.log(`[User ${userId}] 🧹 Limpiando sesión expirada antes de reintentar...`);
          if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
          }
        }

        console.log(`[User ${userId}] 🔄 Reintentando en ${delay / 1000}s...`);
        inst.reconnectTimer = setTimeout(() => {
          startUserInstance(userId, cleanPhone);
        }, delay);
      }
    }
  });

  sock.ev.on('creds.update', () => {
    saveCreds();
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    await userBot.handleMessages(messages);
  });

  return sock;
}

async function initManager() {
  console.log('👥 Manager inicializado. Las conexiones se establecerán bajo demanda.');
}

async function stopUserInstance(userId) {
  const instance = instances.get(userId);
  if (instance) {
    if (instance.reconnectTimer) clearTimeout(instance.reconnectTimer);
    try {
      instance.sock?.end();
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

// 🔥 NUEVA FUNCIÓN: Eliminar TODAS las sesiones guardadas en disco
// Detiene todas las instancias activas y borra todas las carpetas de auth_states
async function clearAllSessions() {
  console.log('🧹 Eliminando TODAS las sesiones...');

  // 1. Detener todas las instancias activas en memoria
  const userIds = [...instances.keys()];
  for (const userId of userIds) {
    const instance = instances.get(userId);
    if (instance) {
      if (instance.reconnectTimer) clearTimeout(instance.reconnectTimer);
      try {
        instance.sock?.end();
      } catch (e) {}
    }
  }
  instances.clear();
  console.log(`🛑 ${userIds.length} instancia(s) detenida(s).`);

  // 2. Borrar todos los directorios de sesión del disco
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

  console.log(`✅ Limpeza completa. ${deletedCount} sesión(es) eliminada(s) del disco.`);
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
  clearAllSessions,   // 🔥 Exportada para usar desde el router admin
  instances,
};
