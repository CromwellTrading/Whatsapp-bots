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
  console.log(`[User ${userId}] Iniciando instancia para ${phoneNumber}`);

  const adapter = await createSupabaseAuthAdapter(userId);
  const { state, saveCreds } = adapter;
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
    },
    browser: ['Ubuntu', 'Chrome', '20.0.0'],
    markOnlineOnConnect: true,
    syncFullHistory: false,
  });

  instances.set(userId, {
    sock,
    qr: null,
    pairingCode: null,
    isConnected: false,
    userData: { userId, phoneNumber }
  });

  const userBot = createUserBot(userId, sock);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const instance = instances.get(userId);
    if (!instance) return;

    if (qr) {
      instance.qr = qr;
      instance.pairingCode = null;
      console.log(`[User ${userId}] QR generado`);
    }

    if (connection === 'open') {
      instance.isConnected = true;
      instance.qr = null;
      instance.pairingCode = null;
      console.log(`[User ${userId}] Conectado a WhatsApp`);

      const settings = await getSettings(userId);
      if (!settings) {
        const defaultSettings = {
          autoReply: { active: false, text: 'Estoy fuera de servicio', startHour: 23, endHour: 8 },
          tasks: [],
          statusTasks: []
        };
        await supabaseAdmin.from('bot_settings').insert({ user_id: userId, data: defaultSettings });
      }
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom) &&
                              lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;

      console.log(`[User ${userId}] Conexión cerrada. Reconectar: ${shouldReconnect}`);
      instance.isConnected = false;

      if (shouldReconnect) {
        await delay(10000);
        startUserInstance(userId, phoneNumber);
      } else if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
        console.log(`[User ${userId}] Sesión cerrada. Eliminando credenciales.`);
        await supabaseAdmin.from('whatsapp_sessions').delete().eq('user_id', userId);
        startUserInstance(userId, phoneNumber);
      }
    }

    if (connection === 'connecting' && !qr && phoneNumber) {
      try {
        await delay(5000);
        const code = await sock.requestPairingCode(phoneNumber);
        instance.pairingCode = code;
        console.log(`[User ${userId}] Código de emparejamiento: ${code?.match(/.{1,4}/g)?.join('-')}`);
      } catch (err) {
        console.error(`[User ${userId}] Error solicitando código:`, err.message);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

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

module.exports = {
  startUserInstance,
  stopUserInstance,
  getUserStatus,
  getAllInstances,
  initManager,
  startUserIfApproved,
  getGroupsForUser,
  instances
};
