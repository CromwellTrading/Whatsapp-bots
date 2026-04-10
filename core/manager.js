const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, delay } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

const { supabaseAdmin } = require('../auth/supabase');
const { createSupabaseAuthAdapter } = require('../auth/sessionAdapter');
const { createUserBot } = require('./userBot');
const { getSettings } = require('../utils/db');

const instances = new Map();

async function startUserInstance(userId, phoneNumber) {
  const cleanPhone = String(phoneNumber).replace(/\D/g, '');
  console.log(`[User ${userId}] 🚀 Iniciando instancia para ${cleanPhone}`);

  const adapter = await createSupabaseAuthAdapter(userId);
  const { state, saveCreds } = adapter;
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[User ${userId}] 📦 Baileys version: ${version.join('.')}`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'debug' }),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'debug' })),
    },
    browser: ['Ubuntu', 'Chrome', '20.0.0'],
    markOnlineOnConnect: true,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  });

  instances.set(userId, {
    sock,
    qr: null,
    pairingCode: null,
    isConnected: false,
    userData: { userId, phoneNumber: cleanPhone }
  });

  const userBot = createUserBot(userId, sock);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, isNewLogin } = update;
    const instance = instances.get(userId);
    if (!instance) return;

    console.log(`[User ${userId}] 📡 Connection update: connection=${connection}, qr=${!!qr}, isNewLogin=${isNewLogin}`);

    if (qr) {
      instance.qr = qr;
      instance.pairingCode = null;
      console.log(`[User ${userId}] 🖼️ QR generado`);
    }

    if (connection === 'open') {
      instance.isConnected = true;
      instance.qr = null;
      instance.pairingCode = null;
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
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`[User ${userId}] ❌ Conexión cerrada. statusCode=${statusCode}, shouldReconnect=${shouldReconnect}`);
      instance.isConnected = false;

      if (shouldReconnect) {
        console.log(`[User ${userId}] 🔄 Reintentando en 10s...`);
        await delay(10000);
        startUserInstance(userId, cleanPhone);
      } else if (statusCode === DisconnectReason.loggedOut) {
        console.log(`[User ${userId}] 🗑️ Sesión cerrada (loggedOut). Eliminando credenciales.`);
        await supabaseAdmin.from('whatsapp_sessions').delete().eq('user_id', userId);
        startUserInstance(userId, cleanPhone);
      }
    }

    if (connection === 'connecting' && !qr && cleanPhone) {
      try {
        await delay(5000);
        console.log(`[User ${userId}] 🔢 Solicitando código de emparejamiento para ${cleanPhone}...`);
        const code = await sock.requestPairingCode(cleanPhone);
        instance.pairingCode = code;
        console.log(`[User ${userId}] 🔢 Código generado: ${code?.match(/.{1,4}/g)?.join('-')}`);
      } catch (err) {
        console.error(`[User ${userId}] ❌ Error solicitando código:`, err);
      }
    }
  });

  sock.ev.on('creds.update', (creds) => {
    console.log(`[User ${userId}] 💾 Credenciales actualizadas`);
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
    qr: instance.qr,
    pairingCode: instance.pairingCode,
    phoneNumber: instance.userData.phoneNumber
  };
}

function getAllInstances() {
  const result = [];
  for (const [userId, instance] of instances.entries()) {
    result.push({
      userId,
      phoneNumber: instance.userData.phoneNumber,
      connected: instance.isConnected,
      hasQR: !!instance.qr
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
    try {
      await instance.sock?.logout();
    } catch (e) {}
    await stopUserInstance(userId);
  }
  await supabaseAdmin.from('whatsapp_sessions').delete().eq('user_id', userId);
  console.log(`[User ${userId}] Sesión eliminada completamente.`);
  return true;
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
  instances
};
