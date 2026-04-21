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

// Logger de debug de Baileys — escribe a consola con nivel debug
// para ver TODOS los mensajes internos de Baileys
const makeBaileysDebugLogger = (userId) => {
  const prefix = `[WA-INTERNAL User:${userId.slice(0,8)}]`;
  return {
    level: 'trace',
    trace: (obj, msg) => console.log(`${prefix} TRACE`, msg || '', typeof obj === 'object' ? JSON.stringify(obj).slice(0, 300) : obj),
    debug: (obj, msg) => console.log(`${prefix} DEBUG`, msg || '', typeof obj === 'object' ? JSON.stringify(obj).slice(0, 300) : obj),
    info:  (obj, msg) => console.log(`${prefix} INFO `, msg || '', typeof obj === 'object' ? JSON.stringify(obj).slice(0, 300) : obj),
    warn:  (obj, msg) => console.warn(`${prefix} WARN `, msg || '', typeof obj === 'object' ? JSON.stringify(obj).slice(0, 300) : obj),
    error: (obj, msg) => console.error(`${prefix} ERROR`, msg || '', typeof obj === 'object' ? JSON.stringify(obj).slice(0, 300) : obj),
    fatal: (obj, msg) => console.error(`${prefix} FATAL`, msg || '', typeof obj === 'object' ? JSON.stringify(obj).slice(0, 300) : obj),
    child: function() { return this; },
  };
};

async function startUserInstance(userId, phoneNumber) {
  const cleanPhone = String(phoneNumber).replace(/\D/g, '');
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[User ${userId}] 🚀 INICIO DE INSTANCIA`);
  console.log(`[User ${userId}]   Número original: "${phoneNumber}"`);
  console.log(`[User ${userId}]   Número limpio:   "${cleanPhone}" (${cleanPhone.length} dígitos)`);
  if (cleanPhone.length < 10) {
    console.error(`[User ${userId}] ❌ ADVERTENCIA CRÍTICA: Número muy corto — falta código de país`);
  }
  console.log(`${'='.repeat(60)}\n`);

  // Cerrar instancia previa completamente
  const existing = instances.get(userId);
  if (existing) {
    console.log(`[User ${userId}] 🔄 Cerrando instancia previa (status=${existing.status})...`);
    if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
    if (existing.pairingTimer) clearTimeout(existing.pairingTimer);
    try { existing.sock?.end(undefined); } catch (e) { console.log(`[User ${userId}]   Error cerrando sock anterior:`, e.message); }
    instances.delete(userId);
    console.log(`[User ${userId}]   Esperando 1.5s para cierre limpio...`);
    await new Promise(r => setTimeout(r, 1500));
  }

  const sessionDir = path.join(AUTH_DIR, userId);
  const sessionExists = fs.existsSync(sessionDir);
  console.log(`[User ${userId}] 📁 Directorio de sesión: ${sessionDir}`);
  console.log(`[User ${userId}]   ¿Existe sesión guardada? ${sessionExists}`);
  if (sessionExists) {
    const files = fs.readdirSync(sessionDir);
    console.log(`[User ${userId}]   Archivos en sesión: [${files.join(', ')}]`);
  }
  if (!sessionExists) fs.mkdirSync(sessionDir, { recursive: true });

  const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);
  console.log(`[User ${userId}] 🔐 Estado de auth cargado:`);
  console.log(`[User ${userId}]   creds.registered = ${authState.creds.registered}`);
  console.log(`[User ${userId}]   creds.me = ${JSON.stringify(authState.creds.me)}`);
  console.log(`[User ${userId}]   creds.pairingCode = ${authState.creds.pairingCode}`);
  console.log(`[User ${userId}]   noiseKey.public existe = ${!!authState.creds.noiseKey?.public}`);
  console.log(`[User ${userId}]   pairingEphemeralKeyPair existe = ${!!authState.creds.pairingEphemeralKeyPair}`);

  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[User ${userId}] 📦 Baileys version: ${version.join('.')} (isLatest=${isLatest})`);

  const baileysLogger = makeBaileysDebugLogger(userId);

  console.log(`[User ${userId}] 🔌 Creando socket WASocket...`);
  const sock = makeWASocket({
    version,
    logger: baileysLogger,
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
  console.log(`[User ${userId}] ✅ Socket creado`);

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

  sock.ev.on('creds.update', () => {
    console.log(`[User ${userId}] 💾 creds.update → guardando credenciales`);
    saveCreds();
  });

  // Loguear TODOS los eventos del socket
  const ALL_EVENTS = [
    'connection.update', 'creds.update', 'messaging-history.set',
    'chats.upsert', 'chats.update', 'chats.phoneNumberShare', 'chats.delete',
    'presence.update', 'contacts.upsert', 'contacts.update',
    'messages.delete', 'messages.update', 'messages.upsert', 'messages.media-update',
    'messages.reaction', 'message-receipt.update', 'groups.upsert', 'groups.update',
    'group-participants.update', 'blocklist.set', 'blocklist.update',
    'call', 'labels.association', 'labels.edit',
  ];

  for (const event of ALL_EVENTS) {
    if (event === 'connection.update' || event === 'creds.update' || event === 'messages.upsert') continue;
    sock.ev.on(event, (data) => {
      const preview = JSON.stringify(data).slice(0, 200);
      console.log(`[User ${userId}] 📨 EVENTO [${event}]:`, preview);
    });
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = update;
    console.log(`\n[User ${userId}] ━━━ connection.update ━━━`);
    console.log(`[User ${userId}]   connection                  = ${connection}`);
    console.log(`[User ${userId}]   qr                          = ${!!qr}`);
    console.log(`[User ${userId}]   isNewLogin                  = ${isNewLogin}`);
    console.log(`[User ${userId}]   receivedPendingNotifications= ${receivedPendingNotifications}`);
    if (lastDisconnect) {
      console.log(`[User ${userId}]   lastDisconnect.statusCode   = ${lastDisconnect?.error?.output?.statusCode}`);
      console.log(`[User ${userId}]   lastDisconnect.message      = ${lastDisconnect?.error?.message}`);
    }

    const inst = instances.get(userId);
    if (!inst) { console.log(`[User ${userId}]   ⚠️ inst ya no existe — ignorando`); return; }

    if (qr) {
      console.log(`[User ${userId}]   ⚠️ QR recibido — ignorado (modo código de emparejamiento)`);
    }

    if (connection === 'open') {
      inst.isConnected = true;
      inst.qrBase64 = null;
      inst.pairingCode = null;
      inst.status = 'connected';
      console.log(`[User ${userId}] ✅ ¡CONECTADO A WHATSAPP!`);

      const settings = await getSettings(userId);
      if (!settings) {
        console.log(`[User ${userId}] 📝 Creando configuración por defecto...`);
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
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(`[User ${userId}] ❌ CONEXIÓN CERRADA`);
      console.log(`[User ${userId}]   statusCode = ${statusCode}`);
      console.log(`[User ${userId}]   isLoggedOut = ${isLoggedOut}`);

      inst.isConnected = false;
      inst.status = 'disconnected';

      if (isLoggedOut) {
        console.log(`[User ${userId}] 🗑️ Logout — eliminando sesión`);
        if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
      } else {
        console.log(`[User ${userId}] 🔄 Reconectando en 5s...`);
        inst.reconnectTimer = setTimeout(() => reconnectUserInstance(userId, cleanPhone, sessionDir), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    console.log(`[User ${userId}] 📩 messages.upsert: ${messages.length} mensaje(s)`);
    await userBot.handleMessages(messages);
  });

  // Solicitar código de emparejamiento tras 3 segundos
  if (!authState.creds.registered) {
    instanceState.status = 'requesting_code';
    console.log(`[User ${userId}] ⏳ Programando solicitud de código en 3 segundos...`);

    instanceState.pairingTimer = setTimeout(async () => {
      const inst = instances.get(userId);
      if (!inst) { console.log(`[User ${userId}] ⚠️ Timer: inst ya no existe`); return; }
      if (inst.isConnected) { console.log(`[User ${userId}] ℹ️ Timer: ya conectado, no se necesita código`); return; }

      console.log(`\n[User ${userId}] ━━━ SOLICITANDO CÓDIGO DE EMPAREJAMIENTO ━━━`);
      console.log(`[User ${userId}]   Número: +${cleanPhone} (${cleanPhone.length} dígitos)`);
      console.log(`[User ${userId}]   sock.authState.creds.registered = ${sock.authState?.creds?.registered}`);
      console.log(`[User ${userId}]   sock.authState.creds.me = ${JSON.stringify(sock.authState?.creds?.me)}`);
      console.log(`[User ${userId}]   sock.authState.creds.pairingCode antes = ${sock.authState?.creds?.pairingCode}`);

      try {
        if (!sock.authState.creds.registered) {
          console.log(`[User ${userId}]   Llamando sock.requestPairingCode("${cleanPhone}")...`);
          const code = await sock.requestPairingCode(cleanPhone);

          console.log(`[User ${userId}]   ✅ Respuesta de requestPairingCode: "${code}"`);
          console.log(`[User ${userId}]   sock.authState.creds.pairingCode después = ${sock.authState?.creds?.pairingCode}`);
          console.log(`[User ${userId}]   sock.authState.creds.me después = ${JSON.stringify(sock.authState?.creds?.me)}`);

          const formattedCode = code?.match(/.{1,4}/g)?.join('-') ?? code;
          const currentInst = instances.get(userId);
          if (currentInst) {
            currentInst.pairingCode = formattedCode;
            currentInst.pairingCodeRequestedAt = Date.now();
            currentInst.status = 'pairing';
          }
          console.log(`[User ${userId}] ✅ CÓDIGO LISTO: ${formattedCode}`);
          console.log(`[User ${userId}]   WhatsApp debería haber enviado notificación a +${cleanPhone}`);
          console.log(`[User ${userId}]   Esperando que el usuario acepte y vincule...`);
        } else {
          console.log(`[User ${userId}] ℹ️ Sesión ya registrada en socket, no necesita código`);
          if (inst) inst.status = 'connecting';
        }
      } catch (err) {
        console.error(`\n[User ${userId}] ❌ ERROR al pedir código de emparejamiento:`);
        console.error(`[User ${userId}]   message: ${err?.message}`);
        console.error(`[User ${userId}]   output: ${JSON.stringify(err?.output)}`);
        console.error(`[User ${userId}]   stack: ${err?.stack?.split('\n').slice(0,3).join(' | ')}`);
        const currentInst = instances.get(userId);
        if (currentInst) currentInst.status = 'disconnected';
      }
    }, 3000);
  } else {
    console.log(`[User ${userId}] ℹ️ Sesión ya registrada (creds.registered=true) — reconectando sin código`);
  }

  return sock;
}

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
      console.log(`[User ${userId}] ✅ Reconectado`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(`[User ${userId}] ❌ [reconexión] Cerrado. statusCode=${statusCode}`);
      inst.isConnected = false;
      inst.status = 'disconnected';

      if (isLoggedOut) {
        if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
      } else {
        inst.reconnectTimer = setTimeout(() => reconnectUserInstance(userId, cleanPhone, sessionDir), 5000);
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
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
  console.log(`[User ${userId}] Sesión eliminada completamente.`);
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
