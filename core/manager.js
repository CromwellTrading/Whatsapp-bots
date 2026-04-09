const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, delay } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const QRCode = require('qrcode');

const { supabaseAdmin } = require('../auth/supabase');
const { createSupabaseAuthAdapter } = require('../auth/sessionAdapter');
const { createUserBot } = require('./userBot');
const { getSettings } = require('../utils/db');

// Almacén global de instancias activas
const instances = new Map(); // userId -> { sock, qr, pairingCode, isConnected, userData }

/**
 * Inicia una instancia de WhatsApp para un usuario específico
 */
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

  // Guardar en el mapa
  instances.set(userId, {
    sock,
    qr: null,
    pairingCode: null,
    isConnected: false,
    userData: { userId, phoneNumber }
  });

  // Configurar los manejadores de eventos del usuario
  const userBot = createUserBot(userId, sock);
  
  // Eventos de conexión
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
      
      // Inicializar configuración por defecto si no existe
      const settings = await getSettings(userId);
      if (!settings) {
        const defaultSettings = {
          autoReply: { active: false, text: 'Estoy fuera de servicio', startHour: 23, endHour: 8 },
          tasks: []
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

    // Solicitar código de 8 dígitos cuando está conectando y no hay QR
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
  
  // Pasar eventos de mensajes al userBot
  sock.ev.on('messages.upsert', async ({ messages }) => {
    await userBot.handleMessages(messages);
  });

  return sock;
}

/**
 * Inicializa el gestor: levanta instancias para todos los usuarios existentes
 */
async function initManager() {
  // Obtener todos los usuarios de la tabla profiles
  const { data: profiles, error } = await supabaseAdmin
    .from('profiles')
    .select('id, phone_number');
  
  if (error) {
    console.error('Error al cargar perfiles:', error);
    return;
  }

  console.log(`👥 Cargando ${profiles.length} usuarios...`);
  
  for (const profile of profiles) {
    // Iniciar instancia (con un pequeño delay entre cada una para no saturar)
    await startUserInstance(profile.id, profile.phone_number);
    await delay(2000);
  }
}

/**
 * Detiene la instancia de un usuario
 */
async function stopUserInstance(userId) {
  const instance = instances.get(userId);
  if (instance) {
    try {
      instance.sock?.end();
    } catch (e) {}
    instances.delete(userId);
  }
}

/**
 * Obtiene el estado de un usuario
 */
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

/**
 * Obtiene todas las instancias (para admin)
 */
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

module.exports = {
  startUserInstance,
  stopUserInstance,
  getUserStatus,
  getAllInstances,
  initManager,
  instances
};
