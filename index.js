require('dotenv').config();
const { default: makeWASocket, DisconnectReason, downloadMediaMessage, Browsers, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
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
const saveDB = () => supabase.from('bot_settings').update({ data: db }).eq('id', 'default_config').then();

let qrActual = '';
let pairingCode = null;
let estaConectado = false;
let scheduledJobs = {};
let pairingRequested = false;

// ============================================================================
// 2. ADAPTADOR DE SESIÓN DE BAILEYS PARA SUPABASE
// ============================================================================
async function useSupabaseAuthState(sessionName) {
    const writeData = async (data, id) => {
        const json = JSON.stringify(data, BufferJSON.replacer);
        await supabase.from('whatsapp_sessions').upsert({ id: `${sessionName}-${id}`, session_data: json });
    };

    const readData = async (id) => {
        const { data } = await supabase.from('whatsapp_sessions').select('session_data').eq('id', `${sessionName}-${id}`).maybeSingle();
        if (data) return JSON.parse(data.session_data, BufferJSON.reviver);
        return null;
    };

    const removeData = async (id) => {
        await supabase.from('whatsapp_sessions').delete().eq('id', `${sessionName}-${id}`);
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
                            value = baileys.proto.Message.AppStateSyncKeyData.fromObject(value);
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
    db.tasks.forEach((task, index) => {
        if (!task.enabled) return;
        scheduledJobs[index] = cron.schedule(task.cronTime, async () => {
            try {
                let content = {};
                if (task.mediaPath && fs.existsSync(task.mediaPath)) content = { image: fs.readFileSync(task.mediaPath), caption: task.message };
                else content = { text: task.message };
                if (task.targetId === 'status@broadcast') await sock.sendMessage('status@broadcast', content, { statusJidList: [sock.user.id] });
                else await sock.sendMessage(task.targetId, content);
            } catch(e) { console.error(e); }
        }, { timezone: ZONA_HORARIA });
    });
    cron.schedule('0 12 * * *', () => { db.autoReply.repliedToday = []; saveDB(); }, { timezone: ZONA_HORARIA });
}

// ============================================================================
// 4. INICIO DEL BOT (BAILEYS)
// ============================================================================
async function connectToWhatsApp() {
    const { data: configData, error } = await supabase.from('bot_settings').select('data').eq('id', 'default_config').single();
    if (error || !configData) db = { autoReply: { active: false, text: "Offline.", startHour: 23, endHour: 8, repliedToday: [] }, tasks: [], logGroups: false };
    else db = configData.data;

    const { state, saveCreds } = await useSupabaseAuthState('referi');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
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
                    console.log(`⏳ Generando código para +${BOT_PHONE_NUMBER}...`);
                    setTimeout(async () => {
                        try {
                            const code = await sock.requestPairingCode(BOT_PHONE_NUMBER);
                            pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
                            console.log(`\n=========================================\n🔢 CÓDIGO DE VINCULACIÓN EN LOGS: ${pairingCode}\n=========================================\n`);
                        } catch (err) {
                            console.error('❌ Error código:', err.message);
                            pairingRequested = false;
                        }
                    }, 3000); 
                }
            } else {
                qrActual = await qrcode.toDataURL(qr);
                console.log("✅ QR generado en la web.");
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            estaConectado = false;

            if (statusCode === 405 || statusCode === 401 || !shouldReconnect) {
                console.log('⚠️ Sesión rota o desvinculada. Limpiando Supabase...');
                qrActual = ''; pairingCode = null; pairingRequested = false;
                await supabase.from('whatsapp_sessions').delete().like('id', 'referi-%');
                setTimeout(connectToWhatsApp, 3000);
            } else {
                console.log(`❌ Conexión interrumpida (Código: ${statusCode}). Reconectando...`);
                setTimeout(connectToWhatsApp, 5000);
            }
        } else if (connection === 'open') {
            estaConectado = true; qrActual = ''; pairingCode = null;
            console.log('✅ BOT REFERI MILLOBET CONECTADO EXITOSAMENTE');
            iniciarCronJobs(sock);
        }
    });

    // Procesamiento de comandos
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message) return;

        const remoteJid = msg.key.remoteJid;
        const isFromMe = msg.key.fromMe;
        const isGroup = remoteJid.endsWith('@g.us');
        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || "";

        if (isFromMe && textMessage.startsWith('!ping')) {
            await sock.sendMessage(remoteJid, { text: '✅ Pong! Bot funcionando con Baileys + Supabase.' });
        }
    });
}

// ============================================================================
// 5. SERVIDOR WEB
// ============================================================================
app.get('/', (req, res) => {
    if (estaConectado) {
        res.send('<div style="font-family:sans-serif;text-align:center;margin-top:50px;"><h1 style="color:green;">✅ REFERI MILLOBET EN LÍNEA</h1><p>Conectado a WhatsApp con Baileys y respaldado en Supabase.</p></div>');
    } else if (qrActual && !BOT_PHONE_NUMBER) {
        res.send(`
            <div style="font-family:sans-serif;text-align:center;margin-top:50px;">
                <h1>📱 Escanea el código QR</h1>
                <img src="${qrActual}" style="width:300px;border:1px solid #ccc;padding:10px;border-radius:10px;">
                <script>setTimeout(() => location.reload(), 5000);</script>
            </div>
        `);
    } else {
        res.send('<div style="font-family:sans-serif;text-align:center;margin-top:50px;"><h1>⏳ El bot está arrancando...</h1><p><b>Por favor, mira los Logs de Render para ver tu código de vinculación.</b></p><script>setTimeout(()=>location.reload(),5000);</script></div>');
    }
});

app.listen(PORT, () => {
    console.log(`🌐 Servidor web en puerto ${PORT}`);
    connectToWhatsApp();
});
