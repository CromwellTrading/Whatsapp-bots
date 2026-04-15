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

function normalizePhoneNumber(phoneNumber) {
  return String(phoneNumber || '').replace(/\D/g, '');
}

function safeRemoveDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function clearInstanceTimers(instance) {
  if (!instance) return;
  if (instance.reconnectTimer) clearTimeout(instance.reconnectTimer);
  if (instance.pairingCodeTimer) clearTimeout(instance.pairingCodeTimer);
  instance.reconnectTimer = null;
  instance.pairingCodeTimer = null;
}

async function requestPairingCodeForInstance(userId) {
  const inst = instances.get(userId);
  if (!inst || !inst.sock) return;

  if (inst.pairingCodeRequested) return;
  if (inst.isConnected) return;

  inst.pairingCodeRequested = true;
  inst.status = 'requesting_code';

  try {
    const code = await inst.sock.requestPairingCode(inst.phoneNumber);
    const formattedCode = code?.match(/.{1,4}/g)?.join('-') ?? code;

    const current = instances.get(userId);
    if (!current) return;

    current.pairingCode = formattedCode;
    current.qrBase64 = null;
    current.status = 'pairing';
    current.pairingCodeGeneratedAt = Date.now();

    console.log(`[User ${userId}] ✅ Código obtenido: ${formattedCode} — notificación enviada al teléfono.`);
  } catch (e) {
    console.error(`[User ${userId}] ❌ Error al solicitar código:`, e?.message || e);

    const current = instances.get(userId);
    if (current) {
      current.status = 'disconnected';
      current.pairingCodeRequested = false;
      current.pairingCode = null;
    }
  }
}

async function startUserInstance(userId, phoneNumber, usePairingCode = false) {
  const cleanPhone = normalizePhoneNumber(phoneNumber);
  console.log(`[User ${userId}] Iniciando instancia para ${cleanPhone} (pairingCode=${usePairingCode})`);

  const existing = instances.get(userId);
  if (existing) {
    clearInstanceTimers(existing);
    if (existing.sock) {
      try { existing.sock.end(); } catch (_) {}
    }
  }

  const sessionDir = path.join(AUTH_DIR, userId);

  if (usePairingCode) {
    if (fs.existsSync(sessionDir)) {
      safeRemoveDir(sessionDir);
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
    mobile: false,
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
    pairingCodeTimer: null,
    reconnectAttempts: 0,
    usePairingCode,
    pairingCodeRequested: false,
    pairingCodeGeneratedAt: null,
  };

  instances.set(userId, instanceState);

  const userBot = createUserBot(userId, sock);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, pairingCode } = update;
    const inst = instances.get(userId);
    if (!inst) return;

    console.log(
      `[User ${userId}] connection.update: connection=${connection}, qr=${!!qr}, pairingCode=${!!pairingCode}`
    );

    if (qr) {
      if (!usePairingCode) {
        try {
          inst.qrBase64 = await QRCode.toDataURL(qr);
          inst.pairingCode = null;
          inst.status = 'qr_pending';
          console.log(`[User ${userId}] QR generado.`);
        } catch (e) {
          console.error(`[User ${userId}] Error generando QR:`, e.message);
        }
      } else {
        console.log(`[User ${userId}] QR ignorado porque se está usando pairing code.`);
      }
    }

    if (pairingCode && !inst.pairingCode) {
      inst.pairingCode = pairingCode;
      inst.qrBase64 = null;
      inst.status = 'pairing';
      inst.pairingCodeGeneratedAt = Date.now();
      console.log(`[User ${userId}] Código del servidor: ${pairingCode}`);
    }

    if (connection === 'open') {
      inst.isConnected = true;
      inst.qrBase64 = null;
      inst.pairingCode = null;
      inst.status = 'connected';
      inst.reconnectAttempts = 0;
      inst.pairingCodeRequested = false;
      inst.pairingCodeGeneratedAt = null;

      clearInstanceTimers(inst);

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

      const codeAge = inst.pairingCodeGeneratedAt ? Date.now() - inst.pairingCodeGeneratedAt : Infinity;
      const isRecentPairing = inst.usePairingCode && inst.pairingCode && codeAge < 120000;

      clearInstanceTimers(inst);

      if (isLoggedOut && isRecentPairing) {
        inst.status = 'pairing';
        inst.pairingCodeRequested = false;
        console.log(
          `[User ${userId}] Recibido 401 pero el código de emparejamiento es reciente. ` +
          `No se borra la sesión ni se reinicia automáticamente. Esperando entrada del usuario...`
        );
        return;
      }

      if (isLoggedOut && !isRecentPairing) {
        inst.status = 'disconnected';
        inst.pairingCode = null;
        console.log(`[User ${userId}] Sesión cerrada (loggedOut). Limpiando archivos.`);
        safeRemoveDir(sessionDir);
        instances.delete(userId);
        return;
      }

      inst.status = 'disconnected';
      const attempt = inst.reconnectAttempts || 0;
      const delayMs = Math.min(10000 + attempt * 5000, 60000);
      inst.reconnectAttempts = attempt + 1;

      console.log(`[User ${userId}] Reintentando en ${delayMs / 1000}s (intento ${attempt + 1})...`);
      inst.reconnectTimer = setTimeout(() => {
        startUserInstance(userId, cleanPhone, false);
      }, delayMs);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    await userBot.handleMessages(messages);
  });

  if (usePairingCode) {
    instanceState.pairingCodeTimer = setTimeout(async () => {
      const currentInst = instances.get(userId);
      if (!currentInst || !currentInst.sock) {
        console.warn(`[User ${userId}] Instancia o socket desapareció antes de solicitar código.`);
        return;
      }

      if (currentInst.sock.authState?.creds?.registered) {
        currentInst.status = 'connected';
        currentInst.pairingCodeRequested = false;
        console.log(`[User ${userId}] Ya existe sesión registrada, no se solicita código.`);
        return;
      }

      console.log(`[User ${userId}] Solicitando código de emparejamiento para ${cleanPhone}...`);
      await requestPairingCodeForInstance(userId);
    }, 3000);
  }

  return sock;
}

async function initManager() {
  console.log('Manager inicializado. Las conexiones se establecerán bajo demanda.');
}

async function stopUserInstance(userId) {
  const instance = instances.get(userId);
  if (instance) {
    clearInstanceTimers(instance);
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
    clearInstanceTimers(instance);
    try { await instance.sock?.logout(); } catch (_) {}
    await stopUserInstance(userId);
  }

  const sessionDir = path.join(AUTH_DIR, userId);
  safeRemoveDir(sessionDir);
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
