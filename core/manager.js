const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  Browsers,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const { supabaseAdmin } = require('../auth/supabase');
const { createUserBot } = require('./userBot');
const { getSettings } = require('../utils/db');

const instances = new Map();
const AUTH_DIR = path.join(__dirname, '..', 'auth_states');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

async function startUserInstance(userId, phoneNumber, usePairingCode = false) {
  const cleanPhone = String(phoneNumber).replace(/\D/g, '');
  console.log(`[User ${userId}] Iniciando instancia para ${cleanPhone} (pairingCode=${usePairingCode})`);

  // Detener instancia existente
  const existing = instances.get(userId);
  if (existing?.reconnectTimer) clearTimeout(existing.reconnectTimer);
  if (existing?.sock) {
    try { existing.sock.end(); } catch (_) {}
  }

  const sessionDir = path.join(AUTH_DIR, userId);

  // CLAVE: para pairing code siempre empezar con sesión limpia.
  // Con archivos de sesión previos (de un QR anterior) WhatsApp
  // devuelve 401 inmediatamente y cancela el intento.
  if (usePairingCode) {
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log(`[User ${userId}] Sesión anterior eliminada para inicio limpio.`);
    }
  }

  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[User ${userId}] Baileys version: ${version.join('.')}`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, pino({ level: 'silent' })),
    },
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: true,
    syncFullHistory: false,
    connectTimeoutMs: 120000,
    defaultQueryTimeoutMs: 120000,
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
    reconnectAttempts: 0,
    usePairingCode,
    pairingCodeRequested: false,
  };
  instances.set(userId, instanceState);

  const userBot = createUserBot(userId, sock);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, pairingCode } = update;
    const inst = instances.get(userId);
    if (!inst) return;

    console.log(`[User ${userId}] connection.update: connection=${connection}, qr=${!!qr}, pairingCode=${!!pairingCode}`);

    // Cuando el servidor emite el QR, eso significa que el WebSocket está
    // listo y el servidor tiene el qrRef necesario para el pairing code.
    // Llamamos requestPairingCode aquí, con sesión limpia → funciona.
    if (qr) {
      if (usePairingCode && !inst.pairingCodeRequested) {
        inst.pairingCodeRequested = true;
        inst.status = 'requesting_code';
        console.log(`[User ${userId}] Servidor listo — solicitando código para ${cleanPhone}...`);
        try {
          const code = await sock.requestPairingCode(cleanPhone);
          const instNow = instances.get(userId);
          if (instNow) {
            instNow.pairingCode = code;
            instNow.qrBase64 = null;
            instNow.status = 'pairing';
          }
          console.log(`[User ${userId}] Código obtenido: ${code} — notificación enviada al teléfono.`);
        } catch (e) {
          console.error(`[User ${userId}] Error al solicitar código:`, e.message);
          const instNow = instances.get(userId);
          if (instNow) {
            instNow.status = 'disconnected';
            instNow.pairingCodeRequested = false;
          }
        }
      } else if (!usePairingCode) {
        // Modo QR normal
        inst.qrBase64 = await QRCode.toDataURL(qr);
        inst.pairingCode = null;
        inst.status = 'qr_pending';
        console.log(`[User ${userId}] QR generado.`);
      }
    }

    if (pairingCode && !inst.pairingCode) {
      inst.pairingCode = pairingCode;
      inst.qrBase64 = null;
      inst.status = 'pairing';
      console.log(`[User ${userId}] Código del servidor: ${pairingCode}`);
    }

    if (connection === 'open') {
      inst.isConnected = true;
      inst.qrBase64 = null;
      inst.pairingCode = null;
      inst.status = 'connected';
      inst.reconnectAttempts = 0;
      console.log(`[User ${userId}] ✅ CONECTADO a WhatsApp`);

      const settings = await getSettings(userId);
      if (!settings) {
        const defaultSettings = {
          autoReply: { active: false, text: 'Estoy fuera de servicio', startHour: 22, endHour: 8 },
          tasks: [],
          statusTasks: [],
        };
        await supabaseAdmin.from('bot_settings').insert({ user_id: userId, data: defaultSettings });
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`[User ${userId}] Conexión cerrada. statusCode=${statusCode}`);
      inst.isConnected = false;
      inst.qrBase64 = null;
      inst.pairingCode = null;

      if (isLoggedOut) {
        // 401 puede venir si:
        // - El usuario cerró sesión desde el teléfono
        // - El intento de pairing fue rechazado
        // Limpiamos y paramos; el usuario reconecta manualmente.
        inst.status = 'disconnected';
        console.log(`[User ${userId}] Sesión cerrada (loggedOut). Limpiando archivos.`);
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        instances.delete(userId);
      } else {
        // Error de red u otro: reconectar automáticamente
        inst.status = 'disconnected';
        const attempt = inst.reconnectAttempts || 0;
        const delayMs = Math.min(10000 + attempt * 5000, 60000);
        inst.reconnectAttempts = attempt + 1;
        console.log(`[User ${userId}] Reintentando en ${delayMs / 1000}s (intento ${attempt + 1})...`);
        inst.reconnectTimer = setTimeout(() => {
          startUserInstance(userId, cleanPhone, false);
        }, delayMs);
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
  console.log('Manager inicializado. Las conexiones se establecerán bajo demanda.');
}

async function stopUserInstance(userId) {
  const instance = instances.get(userId);
  if (instance) {
    if (instance.reconnectTimer) clearTimeout(instance.reconnectTimer);
    try { instance.sock?.end(); } catch (_) {}
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
      status: instance.status,
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

  if (profile?.is_approved) {
    await stopUserInstance(userId);
    return startUserInstance(userId, profile.phone_number, false);
  }
  return null;
}

async function getGroupsForUser(userId) {
  const instance = instances.get(userId);
  if (!instance?.isConnected) return [];
  try {
    const groups = await instance.sock.groupFetchAllParticipating();
    return Object.entries(groups).map(([id, info]) => ({ id, name: info.subject }));
  } catch (e) {
    console.error(`Error obteniendo grupos de ${userId}:`, e.message);
    return [];
  }
}

async function clearUserSession(userId) {
  const instance = instances.get(userId);
  if (instance) {
    if (instance.reconnectTimer) clearTimeout(instance.reconnectTimer);
    try { await instance.sock?.logout(); } catch (_) {}
    await stopUserInstance(userId);
  }
  const sessionDir = path.join(AUTH_DIR, userId);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
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
  instances,
};
