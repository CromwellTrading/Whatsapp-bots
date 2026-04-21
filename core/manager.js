const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys');
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
const msgRetryCounterCache = new NodeCache();

const AUTH_DIR = path.join(__dirname, '..', 'auth_states');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// Limpieza forzada de sesión parcial: si hay me.id pero no está registrada → sesión inválida
function clearPartialSession(sessionDir) {
  if (fs.existsSync(sessionDir)) {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log(`   🧹 Sesión parcial limpiada: ${sessionDir}`);
    } catch (e) {
      console.error(`   ⚠️ Error limpiando sesión parcial:`, e.message);
    }
  }
}

async function startUserInstance(userId, phoneNumber, usePairingCode = true) {
  const cleanPhone = String(phoneNumber).replace(/\D/g, '');
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[User ${userId.slice(0,8)}] 🚀 INICIO — Número: +${cleanPhone} — Modo: ${usePairingCode ? 'PAIRING CODE' : 'QR'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Cerrar instancia previa completamente
  const existing = instances.get(userId);
  if (existing) {
    if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
    if (existing.pairingTimer) clearTimeout(existing.pairingTimer);
    try { existing.sock?.end(undefined); } catch (e) {}
    instances.delete(userId);
    await new Promise(r => setTimeout(r, 1500));
  }

  const sessionDir = path.join(AUTH_DIR, userId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);
  console.log(`[User ${userId.slice(0,8)}] Auth: registered=${authState.creds.registered}, me=${authState.creds.me?.id}`);

  // Si hay sesión parcial (me.id set pero no registered), es un estado inválido → limpiar
  if (authState.creds.me?.id && !authState.creds.registered) {
    console.log(`[User ${userId.slice(0,8)}] ⚠️ Sesión parcial detectada → limpiando`);
    clearPartialSession(sessionDir);
    fs.mkdirSync(sessionDir, { recursive: true });
    // Reiniciar con sesión limpia
    return startUserInstance(userId, phoneNumber, usePairingCode);
  }

  const { version } = await fetchLatestBaileysVersion();

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
    // QR timeout largo: da más tiempo para que funcione el pairing code SI la notificación llega
    qrTimeout: 60000,
  });

  const instanceState = {
    userId,
    phoneNumber: cleanPhone,
    usePairingCode,
    status: 'connecting',
    sock,
    qrBase64: null,
    pairingCode: null,
    pairingCodeRequestedAt: null,
    isConnected: false,
    reconnectTimer: null,
    pairingTimer: null,
    pairingCodeRequested: false,
  };
  instances.set(userId, instanceState);

  const userBot = createUserBot(userId, sock);

  sock.ev.on('creds.update', () => saveCreds());

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, isNewLogin } = update;
    const inst = instances.get(userId);
    if (!inst) return;

    // QR disponible
    if (qr) {
      console.log(`[User ${userId.slice(0,8)}] 📷 QR recibido`);
      try {
        inst.qrBase64 = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
      } catch (e) {
        console.error(`[User ${userId.slice(0,8)}] Error generando QR:`, e.message);
      }

      // Si estamos en modo pairing code, solicitar el código al recibir el PRIMER QR
      if (usePairingCode && !inst.pairingCodeRequested && !authState.creds.registered) {
        inst.pairingCodeRequested = true;
        if (inst.pairingTimer) clearTimeout(inst.pairingTimer);
        inst.pairingTimer = setTimeout(async () => {
          const currentInst = instances.get(userId);
          if (!currentInst || currentInst.isConnected) return;
          await requestPairingCodeForInstance(sock, userId, cleanPhone, sessionDir);
        }, 3000); // 3 segundos después del primer QR
      }
    }

    if (connection === 'open') {
      inst.isConnected = true;
      inst.qrBase64 = null;
      inst.pairingCode = null;
      inst.status = 'connected';
      console.log(`[User ${userId.slice(0,8)}] ✅ CONECTADO`);

      const settings = await getSettings(userId);
      if (!settings) {
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
      const errMsg = lastDisconnect?.error?.message || '';
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isQRExhausted = statusCode === 408 || errMsg.includes('QR refs attempts ended');
      const isUnauthorized = statusCode === 401;

      console.log(`[User ${userId.slice(0,8)}] ❌ Conexión cerrada — statusCode=${statusCode} msg="${errMsg}"`);

      inst.isConnected = false;
      inst.status = 'disconnected';
      inst.pairingCode = null;
      inst.qrBase64 = null;

      if (isLoggedOut) {
        console.log(`[User ${userId.slice(0,8)}] 🗑️ Logout → eliminando sesión`);
        clearPartialSession(sessionDir);
      } else if (isQRExhausted || isUnauthorized) {
        // QR agotado (408) o sin autorización (401): la sesión parcial causará 401 en el próximo intento
        // → limpiar sesión y reintentar desde cero
        console.log(`[User ${userId.slice(0,8)}] ⚠️ ${isQRExhausted ? 'QR agotado' : '401 no autorizado'} → limpiando sesión parcial`);
        clearPartialSession(sessionDir);
        inst.reconnectTimer = setTimeout(() => startUserInstance(userId, cleanPhone, usePairingCode), 5000);
      } else {
        console.log(`[User ${userId.slice(0,8)}] 🔄 Reconectando en 5s...`);
        inst.reconnectTimer = setTimeout(() => reconnectUserInstance(userId, cleanPhone, sessionDir, usePairingCode), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    await userBot.handleMessages(messages);
  });

  // Si ya está registrado (reconexión de sesión existente), no pedir código
  if (authState.creds.registered) {
    console.log(`[User ${userId.slice(0,8)}] ℹ️ Sesión registrada → reconectando`);
  }

  return sock;
}

async function requestPairingCodeForInstance(sock, userId, cleanPhone, sessionDir) {
  const inst = instances.get(userId);
  if (!inst) return;
  if (inst.isConnected) return;

  console.log(`[User ${userId.slice(0,8)}] 📲 Solicitando código de emparejamiento para +${cleanPhone}...`);
  try {
    const code = await sock.requestPairingCode(cleanPhone);
    const formattedCode = code?.match(/.{1,4}/g)?.join('-') ?? code;
    const currentInst = instances.get(userId);
    if (currentInst) {
      currentInst.pairingCode = formattedCode;
      currentInst.pairingCodeRequestedAt = Date.now();
      currentInst.status = 'pairing';
    }
    console.log(`[User ${userId.slice(0,8)}] ✅ CÓDIGO: ${formattedCode}`);
  } catch (err) {
    console.error(`[User ${userId.slice(0,8)}] ❌ Error solicitando código:`, err?.message);
  }
}

async function reconnectUserInstance(userId, cleanPhone, sessionDir, usePairingCode) {
  const existing = instances.get(userId);
  if (existing?.isConnected) return;

  if (!fs.existsSync(sessionDir)) {
    console.log(`[User ${userId.slice(0,8)}] ℹ️ Sin sesión guardada — iniciando nueva`);
    return startUserInstance(userId, cleanPhone, usePairingCode);
  }

  console.log(`[User ${userId.slice(0,8)}] 🔄 Reconectando con sesión existente...`);

  const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);

  // Verificar sesión parcial
  if (authState.creds.me?.id && !authState.creds.registered) {
    console.log(`[User ${userId.slice(0,8)}] ⚠️ Sesión parcial detectada en reconexión → limpiando`);
    clearPartialSession(sessionDir);
    return startUserInstance(userId, cleanPhone, usePairingCode);
  }

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
    qrTimeout: 60000,
  });

  const inst = instances.get(userId);
  if (inst) {
    inst.sock = sock;
    inst.status = 'connecting';
    inst.pairingCodeRequested = false;
  }

  sock.ev.on('creds.update', () => saveCreds());

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const inst = instances.get(userId);
    if (!inst) return;

    if (qr) {
      console.log(`[User ${userId.slice(0,8)}] 📷 QR (reconexión)`);
      try { inst.qrBase64 = await QRCode.toDataURL(qr, { width: 280, margin: 2 }); } catch (e) {}
    }

    if (connection === 'open') {
      inst.isConnected = true;
      inst.status = 'connected';
      inst.pairingCode = null;
      inst.qrBase64 = null;
      console.log(`[User ${userId.slice(0,8)}] ✅ Reconectado`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errMsg = lastDisconnect?.error?.message || '';
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isQRExhausted = statusCode === 408 || errMsg.includes('QR refs attempts ended');
      const isUnauthorized = statusCode === 401;

      console.log(`[User ${userId.slice(0,8)}] ❌ Cerrado (reconex) — ${statusCode}`);
      inst.isConnected = false;
      inst.status = 'disconnected';

      if (isLoggedOut || isQRExhausted || isUnauthorized) {
        clearPartialSession(sessionDir);
        inst.reconnectTimer = setTimeout(() => startUserInstance(userId, cleanPhone, usePairingCode), 5000);
      } else {
        inst.reconnectTimer = setTimeout(() => reconnectUserInstance(userId, cleanPhone, sessionDir, usePairingCode), 5000);
      }
    }
  });

  const userBot = createUserBot(userId, sock);
  sock.ev.on('messages.upsert', async ({ messages }) => {
    await userBot.handleMessages(messages);
  });
}

async function initManager() {
  console.log('👥 Manager inicializado.');
}

async function stopUserInstance(userId) {
  const instance = instances.get(userId);
  if (instance) {
    if (instance.reconnectTimer) clearTimeout(instance.reconnectTimer);
    if (instance.pairingTimer) clearTimeout(instance.pairingTimer);
    try { instance.sock?.end(undefined); } catch (e) {}
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
    usePairingCode: instance.usePairingCode,
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
    if (instance.pairingTimer) clearTimeout(instance.pairingTimer);
    try { await instance.sock?.logout(); } catch (e) {}
    await stopUserInstance(userId);
  }
  const sessionDir = path.join(AUTH_DIR, userId);
  clearPartialSession(sessionDir);
  console.log(`[User ${userId.slice(0,8)}] Sesión eliminada completamente.`);
  return true;
}

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

  let deletedCount = 0;
  if (fs.existsSync(AUTH_DIR)) {
    for (const entry of fs.readdirSync(AUTH_DIR)) {
      try {
        fs.rmSync(path.join(AUTH_DIR, entry), { recursive: true, force: true });
        deletedCount++;
      } catch (e) {}
    }
  }
  console.log(`✅ Limpieza completa. ${deletedCount} sesión(es) eliminada(s).`);
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
