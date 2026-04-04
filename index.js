require('dotenv').config();
const { default: makeWASocket, DisconnectReason, Browsers, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const cron = require('node-cron');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

// ============================================================================
// 1. CONFIGURACIÓN DEL ENTORNO Y SUPABASE
// ============================================================================
const app = express();
const PORT = process.env.PORT || 3000;
const ZONA_HORARIA = process.env.TZ || "America/Havana";
const BOT_PHONE_NUMBER = process.env.BOT_PHONE_NUMBER || null;
const MEDIA_DIR = './media';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);

let db = null;
const saveDB = async () => {
    try {
        await supabase.from('bot_settings').update({ data: db }).eq('id', 'default_config');
    } catch (err) {
        console.error('❌ Error guardando configuración en DB:', err.message);
    }
};

let qrActual = '';
let pairingCode = null;
let estaConectado = false;
let scheduledJobs = {};
let pairingRequested = false;

// ============================================================================
// 2. ADAPTADOR DE SESIÓN DE BAILEYS PARA SUPABASE MEJORADO
// ============================================================================
async function useSupabaseAuthState(sessionName) {
    const writeData = async (data, id) => {
        try {
            const json = JSON.stringify(data, BufferJSON.replacer);
            const { error } = await supabase.from('whatsapp_sessions').upsert({ id: `${sessionName}-${id}`, session_data: json });
            if (error) {
                console.error(`❌ Supabase rechazó escribir [${id}]:`, error.message);
            }
        } catch (err) {
            console.error(`❌ Error fatal escribiendo [${id}]:`, err.message);
        }
    };

    const readData = async (id) => {
        try {
            const { data, error } = await supabase.from('whatsapp_sessions').select('session_data').eq('id', `${sessionName}-${id}`).maybeSingle();
            if (error) console.error(`❌ Supabase rechazó leer [${id}]:`, error.message);
            if (data) return JSON.parse(data.session_data, BufferJSON.reviver);
            return null;
        } catch (err) {
            console.error(`❌ Error fatal leyendo [${id}]:`, err.message);
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            const { error } = await supabase.from('whatsapp_sessions').delete().eq('id', `${sessionName}-${id}`);
            if (error) console.error(`❌ Supabase rechazó borrar [${id}]:`, error.message);
        } catch (err) {
            console.error(`❌ Error fatal borrando [${id}]:`, err.message);
        }
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            // Carga correcta de las llaves usando prototipos de Baileys
                            value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) tasks.push(writeData(value, key));
                            else tasks.push(removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

// ============================================================================
// 3. MOTOR DE TAREAS
// ============================================================================
function iniciarCronJobs(sock) {
    Object.values(scheduledJobs).forEach(job => job.stop());
    scheduledJobs = {};
    if (!db || !db.tasks) return;

    db.tasks.forEach((task, index) => {
        if (!task.enabled) return;
        scheduledJobs[index] = cron.schedule(task.cronTime, async () => {
            try {
                let content = {};
                if (task.mediaPath && fs.existsSync(task.mediaPath)) content = { image: fs.readFileSync(task.mediaPath), caption: task.message };
                else content = { text: task.message };
                if (task.targetId === 'status@broadcast') await sock.sendMessage('status@broadcast', content, { statusJidList: [sock.user.id] });
                else await sock.sendMessage(task.targetId, content);
            } catch(e) { console.error('Error en tarea programada:', e); }
        }, { timezone: ZONA_HORARIA });
    });
    cron.schedule('0 12 * * *', () => { db.autoReply.repliedToday = []; saveDB(); }, { timezone: ZONA_HORARIA });
}

// ============================================================================
// 4. INICIO DEL BOT (BAILEYS)
// ============================================================================
async function connectToWhatsApp() {
    try {
        const { data: configData, error } = await supabase.from('bot_settings').select('data').eq('id', 'default_config').maybeSingle();
        
        if (error) console.error("⚠️ Error leyendo bot_settings de Supabase:", error.message);
        
        if (!configData) {
            console.log("⚠️ Creando configuración por defecto en memoria.");
            db = { autoReply: { active: false, text: "Offline.", startHour: 23, endHour: 8, repliedToday: [] }, tasks: [], logGroups: false };
        } else {
            db = configData.data;
        }

        const { state, saveCreds } = await useSupabaseAuthState('referi');

        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }), // Puedes cambiar 'silent' a 'info' temporalmente si quieres ver todo el log de Baileys
            browser: Browsers.macOS('Desktop'),
            printQRInTerminal: false,
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && !state.creds.registered) {
                if (BOT_PHONE_NUMBER) {
                    if (!pairingRequested) {
                        pairingRequested = true;
                        console.log(`⏳ Generando código para +${BOT_PHONE_NUMBER} (esperando 5s para evitar bloqueos)...`);
                        setTimeout(async () => {
                            try {
                                const code = await sock.requestPairingCode(BOT_PHONE_NUMBER);
                                pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
                                console.log(`\n=========================================\n🔢 CÓDIGO DE VINCULACIÓN EN LOGS: ${pairingCode}\n=========================================\n`);
                            } catch (err) {
                                console.error('❌ Error pidiendo código:', err.message);
                                pairingRequested = false;
                            }
                        }, 5000); 
                    }
                } else {
                    qrActual = await qrcode.toDataURL(qr);
                    console.log("✅ QR generado (puedes verlo en la URL web).");
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                estaConectado = false;

                console.log(`⚠️ Conexión cerrada. Código de desconexión: ${statusCode}`);

                // 401: Unauthorized, 405: Not Allowed (suele pasar si WhatsApp rechaza la sesión)
                if (statusCode === 405 || statusCode === 401 || !shouldReconnect) {
                    console.log('🧹 Sesión rota o rechazada por WhatsApp. Limpiando DB para intentar desde cero...');
                    qrActual = ''; pairingCode = null; pairingRequested = false;
                    try {
                        await supabase.from('whatsapp_sessions').delete().like('id', 'referi-%');
                    } catch(e) {
                        console.error('❌ Error limpiando DB tras desconexión:', e.message);
                    }
                    setTimeout(connectToWhatsApp, 5000); // Dar 5 segundos de margen
                } else {
                    console.log(`🔄 Reconectando de forma normal...`);
                    setTimeout(connectToWhatsApp, 5000);
                }
            } else if (connection === 'open') {
                estaConectado = true; qrActual = ''; pairingCode = null; pairingRequested = false;
                console.log('✅ BOT REFERI MILLOBET CONECTADO EXITOSAMENTE A WHATSAPP');
                iniciarCronJobs(sock);
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            if (m.type !== 'notify') return;
            const msg = m.messages[0];
            if (!msg.message) return;

            const remoteJid = msg.key.remoteJid;
            const isFromMe = msg.key.fromMe;
            const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

            if (isFromMe && textMessage.startsWith('!ping')) {
                await sock.sendMessage(remoteJid, { text: '✅ Pong! Bot funcionando correctamente.' });
            }
        });
    } catch (e) {
        console.error("❌ Error fatal en connectToWhatsApp:", e);
    }
}

// ============================================================================
// 5. SERVIDOR WEB
// ============================================================================
app.get('/', (req, res) => {
    if (estaConectado) {
        res.send('<div style="font-family:sans-serif;text-align:center;margin-top:50px;"><h1 style="color:green;">✅ REFERI MILLOBET EN LÍNEA</h1><p>Conectado y respaldado en Supabase.</p></div>');
    } else if (qrActual && !BOT_PHONE_NUMBER) {
        res.send(`
            <div style="font-family:sans-serif;text-align:center;margin-top:50px;">
                <h1>📱 Escanea el código QR</h1>
                <img src="${qrActual}" style="width:300px;border:1px solid #ccc;padding:10px;border-radius:10px;">
                <script>setTimeout(() => location.reload(), 5000);</script>
            </div>
        `);
    } else {
        res.send('<div style="font-family:sans-serif;text-align:center;margin-top:50px;"><h1>⏳ El bot está arrancando / Desconectado...</h1><p><b>Revisa los logs de Render para ver tu código de vinculación o detectar errores.</b></p><script>setTimeout(()=>location.reload(),5000);</script></div>');
    }
});

app.listen(PORT, () => {
    console.log(`🌐 Servidor web iniciado en el puerto ${PORT}`);
    connectToWhatsApp();
});
