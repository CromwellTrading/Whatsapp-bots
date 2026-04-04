const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const cron = require('node-cron');
const express = require('express');
const qrcode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

// ============================================================================
// 1. CONFIGURACIÓN DEL ENTORNO Y CONSTANTES GLOBALES
// ============================================================================
const app = express();
const PORT = process.env.PORT || 3000;
const ZONA_HORARIA = process.env.TZ || "America/Havana";
const MEDIA_DIR = './media';
const BOT_PHONE_NUMBER = process.env.BOT_PHONE_NUMBER || null;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Faltan variables SUPABASE_URL o SUPABASE_KEY');
    process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let qrActual = '';
let estaConectado = false;
let scheduledJobs = {};
let reconnectAttempts = 0;
let pairingCode = null;
let pairingRequested = false;
let socketReadyForPairing = false;
const MAX_RECONNECT_ATTEMPTS = 5;

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);

// ============================================================================
// 2. GESTIÓN DE DATOS EN SUPABASE
// ============================================================================
let dbData = null; // caché en memoria

async function loadAppData() {
    const { data, error } = await supabase
        .from('app_data')
        .select('data')
        .order('id', { ascending: false })
        .limit(1)
        .single();
    if (error) {
        console.error('Error cargando app_data:', error);
        // Datos por defecto
        return {
            autoReply: { active: false, text: "Hola, en este momento estoy offline. Te responderé en cuanto esté disponible.", startHour: 23, endHour: 8, repliedToday: [] },
            tasks: [],
            logGroups: false
        };
    }
    return data.data;
}

async function saveAppData(data) {
    const { error } = await supabase
        .from('app_data')
        .insert({ data });
    if (error) console.error('Error guardando app_data:', error);
}

// Inicializar dbData
async function refreshAppData() {
    dbData = await loadAppData();
}
refreshAppData();

function saveDB() {
    if (dbData) saveAppData(dbData);
}

// ============================================================================
// 3. ADAPTADOR DE AUTENTICACIÓN PARA SUPABASE
// ============================================================================
const useSupabaseAuthState = async () => {
    const writeData = async (key, value) => {
        const { error } = await supabase
            .from('auth_creds')
            .upsert({ key, value: JSON.stringify(value, BufferJSON.replacer) }, { onConflict: 'key' });
        if (error) console.error('Error writeAuthData:', error);
    };
    const readData = async (key) => {
        const { data, error } = await supabase
            .from('auth_creds')
            .select('value')
            .eq('key', key)
            .maybeSingle();
        if (error) {
            console.error('Error readAuthData:', error);
            return null;
        }
        return data ? JSON.parse(data.value, BufferJSON.reviver) : null;
    };
    const removeData = async (key) => {
        await supabase.from('auth_creds').delete().eq('key', key);
    };

    let creds = await readData('creds');
    if (!creds) creds = initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const result = {};
                    for (const id of ids) {
                        const key = `${type}-${id}`;
                        const value = await readData(key);
                        if (value) result[id] = value;
                    }
                    return result;
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) await writeData(key, value);
                            else await removeData(key);
                        }
                    }
                }
            }
        },
        saveCreds: async () => {
            await writeData('creds', creds);
        }
    };
};

// ============================================================================
// 4. MOTOR DE TAREAS PROGRAMADAS
// ============================================================================
function iniciarCronJobs(sock) {
    Object.values(scheduledJobs).forEach(job => job.stop());
    scheduledJobs = {};
    if (!dbData) return;
    dbData.tasks.forEach((task, index) => {
        if (!task.enabled) return;
        scheduledJobs[index] = cron.schedule(task.cronTime, async () => {
            try {
                let content = {};
                if (task.mediaPath && fs.existsSync(task.mediaPath)) {
                    const buffer = fs.readFileSync(task.mediaPath);
                    content = { image: buffer, caption: task.message };
                } else {
                    content = { text: task.message };
                }
                if (task.targetId === 'status@broadcast') {
                    await sock.sendMessage('status@broadcast', content, { statusJidList: [sock.user.id] });
                } else {
                    await sock.sendMessage(task.targetId, content);
                }
                console.log(`[Cron] Ejecutada tarea ${index}`);
            } catch(e) { console.error(`Error en tarea ${index}:`, e); }
        }, { timezone: ZONA_HORARIA });
    });
    // Resetear lista de auto-respuesta cada día a las 12:00
    cron.schedule('0 12 * * *', () => {
        if (dbData) {
            dbData.autoReply.repliedToday = [];
            saveDB();
            console.log('[Sistema] Lista de auto-respuestas reiniciada.');
        }
    }, { timezone: ZONA_HORARIA });
}

// ============================================================================
// 5. NÚCLEO DEL CLIENTE DE WHATSAPP
// ============================================================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useSupabaseAuthState();

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'error' }),
        browser: ["REFERI MILLOBET", "Chrome", "20.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    const requestPairing = async () => {
        if (!BOT_PHONE_NUMBER) return;
        if (pairingRequested) return;
        if (!socketReadyForPairing) return;
        if (state.creds.registered) return;
        pairingRequested = true;
        console.log(`📱 Solicitando código de vinculación para +${BOT_PHONE_NUMBER}...`);
        try {
            const code = await sock.requestPairingCode(BOT_PHONE_NUMBER);
            pairingCode = code;
            console.log(`🔢 Código: ${pairingCode}`);
        } catch (err) {
            console.error('Error al solicitar código:', err);
            pairingCode = null;
            if (socketReadyForPairing && !state.creds.registered) {
                pairingRequested = false;
                setTimeout(requestPairing, 5000);
            }
        }
    };

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !BOT_PHONE_NUMBER) {
            reconnectAttempts = 0;
            qrActual = await qrcode.toDataURL(qr);
            console.log("✅ QR generado.");
        }

        if (connection === 'open') {
            reconnectAttempts = 0;
            socketReadyForPairing = true;
            estaConectado = true;
            qrActual = '';
            console.log('✅ BOT CONECTADO EXITOSAMENTE');
            iniciarCronJobs(sock);
            if (BOT_PHONE_NUMBER && !state.creds.registered) {
                await requestPairing();
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            estaConectado = false;
            socketReadyForPairing = false;
            pairingRequested = false;

            if (shouldReconnect) {
                reconnectAttempts++;
                console.log(`❌ Conexión cerrada. Reintento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} en 10s...`);
                if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
                    console.log("⚠️ Demasiados reintentos. Borrando sesión en Supabase...");
                    await supabase.from('auth_creds').delete().neq('key', '');
                    reconnectAttempts = 0;
                    pairingRequested = false;
                    setTimeout(connectToWhatsApp, 5000);
                } else {
                    setTimeout(connectToWhatsApp, 10000);
                }
            } else {
                console.log('🚪 Sesión cerrada desde el teléfono. Esperando nuevo código/QR.');
                qrActual = '';
                pairingCode = null;
                pairingRequested = false;
            }
        }
    });

    // ============================================================================
    // 6. PROCESAMIENTO DE MENSAJES Y COMANDOS
    // ============================================================================
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message) return;

        const remoteJid = msg.key.remoteJid;
        const isFromMe = msg.key.fromMe;
        const isGroup = remoteJid.endsWith('@g.us');

        const textMessage = msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption || "";

        // ========== LOGS DE GRUPOS ==========
        if (isGroup && !isFromMe && dbData && dbData.logGroups) {
            let groupName = remoteJid;
            try { groupName = (await sock.groupMetadata(remoteJid)).subject; } catch(e) {}
            let senderName = remoteJid.split('@')[0];
            if (msg.key.participant) {
                try {
                    const contact = await sock.contactQuery(msg.key.participant);
                    senderName = contact.notify || contact.name || msg.key.participant.split('@')[0];
                } catch(e) {}
            }
            let logContent = `📢 *Grupo:* ${groupName}\n👤 *De:* ${senderName}\n`;
            if (textMessage) logContent += `💬 *Mensaje:* ${textMessage}`;
            else if (msg.message.imageMessage) logContent += `🖼️ *Imagen* (caption: ${msg.message.imageMessage.caption || 'sin texto'})`;
            else if (msg.message.videoMessage) logContent += `🎥 *Video* (caption: ${msg.message.videoMessage.caption || 'sin texto'})`;
            else logContent += `📨 *Otro tipo de mensaje*`;
            await sock.sendMessage(sock.user.id, { text: logContent });
        }

        // ========== AUTO-RESPUESTA INBOX ==========
        if (!isGroup && !isFromMe && dbData && dbData.autoReply.active && remoteJid !== 'status@broadcast') {
            const hora = parseInt(new Date().toLocaleString("en-US", { timeZone: ZONA_HORARIA, hour: 'numeric', hour12: false }));
            const { startHour, endHour, repliedToday, text } = dbData.autoReply;
            const sleeping = startHour > endHour ? (hora >= startHour || hora < endHour) : (hora >= startHour && hora < endHour);
            if (sleeping && !repliedToday.includes(remoteJid)) {
                await sock.sendMessage(remoteJid, { text }, { quoted: msg });
                dbData.autoReply.repliedToday.push(remoteJid);
                saveDB();
            }
        }

        // ========== COMANDOS DEL DUEÑO ==========
        if (isFromMe && textMessage.startsWith('!')) {
            const args = textMessage.slice(1).trim().split(/ +/);
            const command = args.shift().toLowerCase();

            // --- !grupos / !detectid ---
            if (command === 'grupos' || command === 'detectid') {
                const groups = await sock.groupFetchAllParticipating();
                let lista = "*📋 Tus Grupos Activos:*\n";
                Object.values(groups).forEach(g => {
                    lista += `\n👥 *${g.subject}*\n🆔 \`${g.id}\`\n`;
                });
                await sock.sendMessage(remoteJid, { text: lista || "No estás en ningún grupo." });
            }

            // --- !addtask / !setreplygroup ---
            if (command === 'addtask' || command === 'setreplygroup') {
                const targetId = args[0], timeVal = args[1], texto = args.slice(2).join(' ');
                if (!targetId || !timeVal || !texto) return sock.sendMessage(remoteJid, { text: "❌ Formato: !addtask [ID] [HH:MM o minutos] [mensaje]" });
                let cronExp, isInterval;
                if (timeVal.includes(':')) { const [h,m] = timeVal.split(':'); cronExp = `${m} ${h} * * *`; isInterval = false; }
                else { cronExp = `*/${timeVal} * * * *`; isInterval = true; }
                let mediaPath = null;
                const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (quoted?.imageMessage) {
                    try {
                        const buffer = await downloadMediaMessage({ key: msg.message.extendedTextMessage.contextInfo.stanzaId, message: quoted }, 'buffer', {});
                        mediaPath = `${MEDIA_DIR}/img_${Date.now()}.jpg`;
                        fs.writeFileSync(mediaPath, buffer);
                    } catch(e) { return sock.sendMessage(remoteJid, { text: "❌ Error al guardar imagen." }); }
                }
                dbData.tasks.push({ targetId, cronTime: cronExp, message: texto, mediaPath, isInterval, enabled: true });
                saveDB(); iniciarCronJobs(sock);
                sock.sendMessage(remoteJid, { text: `✅ Tarea guardada. ${isInterval ? `Cada ${timeVal} min` : `A las ${timeVal}`}` });
            }

            // --- !addstatus / !setreplystatus ---
            if (command === 'addstatus' || command === 'setreplystatus') {
                const timeVal = args[0], texto = args.slice(1).join(' ');
                if (!timeVal || !texto) return sock.sendMessage(remoteJid, { text: "❌ Formato: !addstatus [HH:MM o minutos] [mensaje]" });
                let cronExp, isInterval;
                if (timeVal.includes(':')) { const [h,m] = timeVal.split(':'); cronExp = `${m} ${h} * * *`; isInterval = false; }
                else { cronExp = `*/${timeVal} * * * *`; isInterval = true; }
                let mediaPath = null;
                const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (quoted?.imageMessage) {
                    try {
                        const buffer = await downloadMediaMessage({ key: msg.message.extendedTextMessage.contextInfo.stanzaId, message: quoted }, 'buffer', {});
                        mediaPath = `${MEDIA_DIR}/img_${Date.now()}.jpg`;
                        fs.writeFileSync(mediaPath, buffer);
                    } catch(e) { return sock.sendMessage(remoteJid, { text: "❌ Error al guardar imagen." }); }
                }
                dbData.tasks.push({ targetId: 'status@broadcast', cronTime: cronExp, message: texto, mediaPath, isInterval, enabled: true });
                saveDB(); iniciarCronJobs(sock);
                sock.sendMessage(remoteJid, { text: `✅ Estado programado. ${isInterval ? `Cada ${timeVal} min` : `A las ${timeVal}`}` });
            }

            // --- !listartareas ---
            if (command === 'listartareas') {
                if (!dbData.tasks.length) return sock.sendMessage(remoteJid, { text: "No hay tareas." });
                let res = "*📋 Tareas Programadas:*\n";
                dbData.tasks.forEach((t,i) => {
                    const destino = t.targetId === 'status@broadcast' ? '🟢 Estado' : '👥 Grupo';
                    const foto = t.mediaPath ? '🖼️ Sí' : '📝 Solo texto';
                    const estado = t.enabled ? '✅ Activa' : '❌ Inactiva';
                    res += `\n*ID ${i}* (${estado})\n📍 ${destino}\n⏱️ Cron: ${t.cronTime}\n📎 Foto: ${foto}\n💬 Texto: ${t.message.substring(0,30)}...\n`;
                });
                sock.sendMessage(remoteJid, { text: res });
            }

            // --- !borrartarea [ID] ---
            if (command === 'borrartarea') {
                let idx = parseInt(args[0]);
                if (dbData.tasks[idx]) {
                    if (dbData.tasks[idx].mediaPath && fs.existsSync(dbData.tasks[idx].mediaPath)) fs.unlinkSync(dbData.tasks[idx].mediaPath);
                    dbData.tasks.splice(idx,1);
                    saveDB(); iniciarCronJobs(sock);
                    sock.sendMessage(remoteJid, { text: `✅ Tarea ${idx} eliminada.` });
                } else sock.sendMessage(remoteJid, { text: "❌ ID inválido." });
            }

            // --- !activartarea / !desactivartarea [ID] ---
            if (command === 'activartarea' || command === 'desactivartarea') {
                let idx = parseInt(args[0]);
                if (dbData.tasks[idx] !== undefined) {
                    dbData.tasks[idx].enabled = (command === 'activartarea');
                    saveDB(); iniciarCronJobs(sock);
                    sock.sendMessage(remoteJid, { text: `✅ Tarea ${idx} ${command==='activartarea'?'activada':'desactivada'}.` });
                } else sock.sendMessage(remoteJid, { text: "❌ ID inválido." });
            }

            // --- !editartarea [ID] [nuevo texto] ---
            if (command === 'editartarea') {
                let idx = parseInt(args[0]), nuevoTexto = args.slice(1).join(' ');
                if (!dbData.tasks[idx]) return sock.sendMessage(remoteJid, { text: "❌ ID inválido." });
                if (nuevoTexto) dbData.tasks[idx].message = nuevoTexto;
                const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (quoted?.imageMessage) {
                    try {
                        if (dbData.tasks[idx].mediaPath && fs.existsSync(dbData.tasks[idx].mediaPath)) fs.unlinkSync(dbData.tasks[idx].mediaPath);
                        const buffer = await downloadMediaMessage({ key: msg.message.extendedTextMessage.contextInfo.stanzaId, message: quoted }, 'buffer', {});
                        const newPath = `${MEDIA_DIR}/img_${Date.now()}.jpg`;
                        fs.writeFileSync(newPath, buffer);
                        dbData.tasks[idx].mediaPath = newPath;
                    } catch(e) { return sock.sendMessage(remoteJid, { text: "❌ Error al actualizar imagen." }); }
                }
                saveDB(); iniciarCronJobs(sock);
                sock.sendMessage(remoteJid, { text: `✅ Tarea ${idx} actualizada.` });
            }

            // --- !editartiempo [ID] [HH:MM o minutos] ---
            if (command === 'editartiempo') {
                let idx = parseInt(args[0]), timeVal = args[1];
                if (!dbData.tasks[idx] || !timeVal) return sock.sendMessage(remoteJid, { text: "❌ Uso: !editartiempo [ID] [HH:MM o minutos]" });
                let cronExp, isInterval;
                if (timeVal.includes(':')) { const [h,m] = timeVal.split(':'); cronExp = `${m} ${h} * * *`; isInterval = false; }
                else { cronExp = `*/${timeVal} * * * *`; isInterval = true; }
                dbData.tasks[idx].cronTime = cronExp; dbData.tasks[idx].isInterval = isInterval;
                saveDB(); iniciarCronJobs(sock);
                sock.sendMessage(remoteJid, { text: `✅ Horario tarea ${idx} actualizado a ${timeVal}.` });
            }

            // --- !estado [texto] (manual) ---
            if (command === 'estado') {
                let texto = args.join(' ');
                if (msg.message.imageMessage || msg.message.videoMessage) {
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        await sock.sendMessage('status@broadcast', { image: buffer, caption: texto }, { statusJidList: [sock.user.id] });
                        sock.sendMessage(remoteJid, { text: "✅ Estado con imagen publicado." });
                    } catch(e) { sock.sendMessage(remoteJid, { text: "❌ Error multimedia." }); }
                } else {
                    await sock.sendMessage('status@broadcast', { text: texto }, { statusJidList: [sock.user.id] });
                    sock.sendMessage(remoteJid, { text: "✅ Estado publicado." });
                }
            }

            // --- !autoreply on/off ---
            if (command === 'autoreply') {
                let mode = args[0];
                if (mode === 'on' || mode === 'off') { dbData.autoReply.active = (mode === 'on'); saveDB(); sock.sendMessage(remoteJid, { text: `✅ Auto-respuesta ${mode.toUpperCase()}.` }); }
                else sock.sendMessage(remoteJid, { text: "Uso: !autoreply on|off" });
            }

            // --- !sethoras [inicio] [fin] ---
            if (command === 'sethoras') {
                let inicio = parseInt(args[0]), fin = parseInt(args[1]);
                if (!isNaN(inicio) && !isNaN(fin)) { dbData.autoReply.startHour = inicio; dbData.autoReply.endHour = fin; saveDB(); sock.sendMessage(remoteJid, { text: `✅ Horario dormir: ${inicio}:00 - ${fin}:00.` }); }
                else sock.sendMessage(remoteJid, { text: "Uso: !sethoras [hora_inicio] [hora_fin]" });
            }

            // --- !setreplytext [texto] ---
            if (command === 'setreplytext') {
                let nuevo = args.join(' ');
                if (nuevo) { dbData.autoReply.text = nuevo; saveDB(); sock.sendMessage(remoteJid, { text: "✅ Mensaje auto-respuesta actualizado." }); }
                else sock.sendMessage(remoteJid, { text: "Uso: !setreplytext [texto]" });
            }

            // --- !loggroups on/off ---
            if (command === 'loggroups') {
                let mode = args[0];
                if (mode === 'on' || mode === 'off') { dbData.logGroups = (mode === 'on'); saveDB(); sock.sendMessage(remoteJid, { text: `✅ Registro grupos ${mode.toUpperCase()}.` }); }
                else sock.sendMessage(remoteJid, { text: "Uso: !loggroups on|off" });
            }

            // --- !mostrarconfig ---
            if (command === 'mostrarconfig') {
                let msg = `🔁 Auto-respuesta: ${dbData.autoReply.active?'ACTIVA':'INACTIVA'}\n⏰ Horario: ${dbData.autoReply.startHour}:00-${dbData.autoReply.endHour}:00\n📝 Texto: ${dbData.autoReply.text}\n📊 Tareas: ${dbData.tasks.length} (${dbData.tasks.filter(t=>t.enabled).length} activas)\n📢 Log grupos: ${dbData.logGroups?'ACTIVO':'INACTIVO'}`;
                sock.sendMessage(remoteJid, { text: msg });
            }
        }
    });
}

// ============================================================================
// 7. SERVIDOR WEB PARA MOSTRAR QR O CÓDIGO
// ============================================================================
app.get('/', (req, res) => {
    if (estaConectado) {
        res.send('<div style="font-family:sans-serif;text-align:center;margin-top:50px;"><h1 style="color:green;">✅ BOT EN LÍNEA</h1><p>El bot está operativo.</p></div>');
    } else if (pairingCode) {
        res.send(`
            <div style="font-family:sans-serif;text-align:center;margin-top:50px;">
                <h1>🔢 Código de vinculación</h1>
                <div style="font-size:48px;font-weight:bold;background:#f0f0f0;padding:20px;border-radius:10px;display:inline-block;margin:20px;">${pairingCode}</div>
                <p>1. Abre WhatsApp > Dispositivos vinculados > Vincular un dispositivo</p>
                <p>2. Ingresa este código de 8 dígitos.</p>
                <script>setTimeout(() => location.reload(), 5000);</script>
            </div>
        `);
    } else if (qrActual) {
        res.send(`
            <div style="font-family:sans-serif;text-align:center;margin-top:50px;">
                <h1>📱 Escanea el código QR</h1>
                <img src="${qrActual}" style="width:300px;">
                <p>Abre WhatsApp > Dispositivos vinculados > Vincular un dispositivo</p>
                <script>setTimeout(() => location.reload(), 5000);</script>
            </div>
        `);
    } else {
        res.send('<div style="font-family:sans-serif;text-align:center;margin-top:50px;"><h1>⏳ Esperando código/QR...</h1><script>setTimeout(()=>location.reload(),3000);</script></div>');
    }
});

app.listen(PORT, () => console.log(`🌐 Servidor web en http://localhost:${PORT}`));

connectToWhatsApp();
