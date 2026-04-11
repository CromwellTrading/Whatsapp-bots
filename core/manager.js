const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, delay, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
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

async function startUserInstance(userId, phoneNumber) {
  const cleanPhone = String(phoneNumber).replace(/\D/g, '');
  console.log(`[User ${userId}] 🚀 Iniciando instancia para ${cleanPhone}`);

  const existing = instances.get(userId);
  if (existing?.reconnectTimer) {
    clearTimeout(existing.reconnectTimer);
  }

  const sessionDir = path.join(AUTH_DIR, userId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[User ${userId}] 📦 Baileys version: ${version.join('.')}`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'debug' }),
    printQRInTerminal: false,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, pino({ level: 'debug' })),
    },
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: true,
    syncFullHistory: false,
    connectTimeoutMs: 120000,           // más tiempo para escanear QR
    defaultQueryTimeoutMs: 120000,
    qrTimeout: 120000,                  // tiempo máximo del QR
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
    qrGeneratedAt: null,
  };
  instances.set(userId, instanceState);

  const userBot = createUserBot(userId, sock);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const inst = instances.get(userId);
    if (!inst) return;

    console.log(`[User ${userId}] 📡 Connection update: connection=${connection}, qr=${!!qr}`);

    if (qr) {
      inst.qrBase64 = await QRCode.toDataURL(qr);
      inst.pairingCode = null;
      inst.status = 'qr_pending';
      inst.qrGeneratedAt = Date.now();
      console.log(`[User ${userId}] 🖼️ QR generado (base64 length: ${inst.qrBase64.length})`);
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
      // Si es 408 (QR timeout) y nunca se escaneó, reintentar con backoff
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`[User ${userId}] ❌ Conexión cerrada. statusCode=${statusCode}, shouldReconnect=${shouldReconnect}`);
      inst.isConnected = false;
      inst.status = 'disconnected';

      if (shouldReconnect) {
        // Backoff progresivo: 10s, 20s, 30s...
        const attempt = inst.reconnectAttempts || 0;
        const delayMs = Math.min(10000 + attempt * 5000, 60000);
        inst.reconnectAttempts = attempt + 1;
        console.log(`[User ${userId}] 🔄 Reintentando en ${delayMs/1000}s...`);
        inst.reconnectTimer = setTimeout(() => {
          startUserInstance(userId, cleanPhone);
        }, delayMs);
      } else if (statusCode === DisconnectReason.loggedOut) {
        console.log(`[User ${userId}] 🗑️ Sesión cerrada (loggedOut). Eliminando archivos.`);
        fs.rmSync(sessionDir, { recursive: true, force: true });
        startUserInstance(userId, cleanPhone);
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
  const sessionDir = path.join(__dirname, '..', 'auth_states', userId);
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
