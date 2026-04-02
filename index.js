const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const cron = require('node-cron');
const express = require('express');
const qrcode = require('qrcode');

// ============================================================================
// 1. CONFIGURACIÓN DEL ENTORNO Y CONSTANTES GLOBALES
// ============================================================================
const app = express();
const PORT = process.env.PORT || 3000;
const ZONA_HORARIA = process.env.TZ || "America/Havana";
const MEDIA_DIR = './media';
const DB_FILE = './database.json';
const AUTH_DIR = 'auth_info_baileys';
const BOT_PHONE_NUMBER = process.env.BOT_PHONE_NUMBER || null; 

let qrActual = '';
let estaConectado = false;
let scheduledJobs = {};
let pairingCode = null;      
let pairingRequested = false; 

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// ============================================================================
// 2. GESTIÓN DE LA BASE DE DATOS (JSON LOCAL)
// ============================================================================
let db = {
    autoReply: { active: false, text: "Hola, en este momento estoy offline. Te responderé en cuanto esté disponible.", startHour: 23, endHour: 8, repliedToday: [] },
    tasks: [],
    logGroups: false
};

if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE)); if (db.logGroups === undefined) db.logGroups = false; } catch(e) { console.error("Error DB", e); }
}
const saveDB = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

// ============================================================================
// 3. MOTOR AVANZADO DE TAREAS PROGRAMADAS Y ESTADOS
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
// 4. NÚCLEO DEL CLIENTE DE WHATSAPP (BAILEYS)
// ============================================================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), 
        browser: Browsers.macOS('Desktop'), // Usar navegador estándar para evitar bloqueos
        printQRInTerminal: false,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Dispara la vinculación solo cuando WhatsApp confirma que está listo enviando el evento 'qr'
        if (qr && !state.creds.registered) {
            if (BOT_PHONE_NUMBER) {
                if (!pairingRequested) {
                    pairingRequested = true;
                    console.log(`\n📲 Conexión estable. Solicitando código para +${BOT_PHONE_NUMBER}...`);
                    try {
                        const code = await sock.requestPairingCode(BOT_PHONE_NUMBER);
                        pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
                        console.log(`\n=========================================\n🔢 TU CÓDIGO DE VINCULACIÓN ES: ${pairingCode}\n=========================================\n`);
                    } catch (err) {
                        console.error('❌ Error al solicitar el código:', err.message);
                        pairingRequested = false; 
                    }
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

            // LÓGICA DE CORRECCIÓN PARA ERRORES 405 y 401
            if (statusCode === 405 || statusCode === 401) {
                console.log(`⚠️ Sesión corrupta o rechazada (Código: ${statusCode}). Borrando datos para generar una nueva...`);
                qrActual = '';
                pairingCode = null;
                pairingRequested = false;
                try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch(e){}
                setTimeout(connectToWhatsApp, 3000); // Reconecta limpio
            } else if (shouldReconnect) {
                console.log(`❌ Conexión interrumpida (Código: ${statusCode || 'N/A'}). Reconectando en 5 segundos...`);
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.log('🚪 Sesión cerrada desde el teléfono. Borrando credenciales...');
                qrActual = '';
                pairingCode = null;
                pairingRequested = false;
                try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch(e){}
                setTimeout(connectToWhatsApp, 3000);
            }
        } else if (connection === 'open') {
            estaConectado = true;
            qrActual = '';
            pairingCode = null;
            console.log('✅ BOT REFERI MILLOBET CONECTADO EXITOSAMENTE');
            iniciarCronJobs(sock);
        }
    });

    // ============================================================================
    // 5. PROCESAMIENTO DE MENSAJES Y COMANDOS
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

        if (isGroup && !isFromMe && db.logGroups) {
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

        if (!isGroup && !isFromMe && db.autoReply.active && remoteJid !== 'status@broadcast') {
            const hora = parseInt(new Date().toLocaleString("en-US", { timeZone: ZONA_HORARIA, hour: 'numeric', hour12: false }));
            const { startHour, endHour, repliedToday, text } = db.autoReply;
            const sleeping = startHour > endHour ? (hora >= startHour || hora < endHour) : (hora >= startHour && hora < endHour);
            if (sleeping && !repliedToday.includes(remoteJid)) {
                await sock.sendMessage(remoteJid, { text }, { quoted: msg });
                db.autoReply.repliedToday.push(remoteJid);
                saveDB();
            }
        }

        if (isFromMe && textMessage.startsWith('!')) {
            const args = textMessage.slice(1).trim().split(/ +/);
            const command = args.shift().toLowerCase();

            if (command === 'grupos' || command === 'detectid') {
                const groups = await sock.groupFetchAllParticipating();
                let lista = "*📋 Tus Grupos Activos:*\n";
                Object.values(groups).forEach(g => lista += `\n👥 *${g.subject}*\n🆔 \`${g.id}\`\n`);
                await sock.sendMessage(remoteJid, { text: lista || "No estás en ningún grupo." });
            }

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
                db.tasks.push({ targetId, cronTime: cronExp, message: texto, mediaPath, isInterval, enabled: true });
                saveDB(); iniciarCronJobs(sock);
                sock.sendMessage(remoteJid, { text: `✅ Tarea guardada. ${isInterval ? `Cada ${timeVal} min` : `A las ${timeVal}`}` });
            }

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
                db.tasks.push({ targetId: 'status@broadcast', cronTime: cronExp, message: texto, mediaPath, isInterval, enabled: true });
                saveDB(); iniciarCronJobs(sock);
                sock.sendMessage(remoteJid, { text: `✅ Estado programado. ${isInterval ? `Cada ${timeVal} min` : `A las ${timeVal}`}` });
            }

            if (command === 'listartareas') {
                if (!db.tasks.length) return sock.sendMessage(remoteJid, { text: "No hay tareas." });
                let res = "*📋 Tareas Programadas:*\n";
                db.tasks.forEach((t,i) => {
                    const destino = t.targetId === 'status@broadcast' ? '🟢 Estado' : '👥 Grupo';
                    const foto = t.mediaPath ? '🖼️ Sí' : '📝 Solo texto';
                    const estado = t.enabled ? '✅ Activa' : '❌ Inactiva';
                    res += `\n*ID ${i}* (${estado})\n📍 ${destino}\n⏱️ Cron: ${t.cronTime}\n📎 Foto: ${foto}\n💬 Texto: ${t.message.substring(0,30)}...\n`;
                });
                sock.sendMessage(remoteJid, { text: res });
            }

            if (command === 'borrartarea') {
                let idx = parseInt(args[0]);
                if (db.tasks[idx]) {
                    if (db.tasks[idx].mediaPath && fs.existsSync(db.tasks[idx].mediaPath)) fs.unlinkSync(db.tasks[idx].mediaPath);
                    db.tasks.splice(idx,1);
                    saveDB(); iniciarCronJobs(sock);
                    sock.sendMessage(remoteJid, { text: `✅ Tarea ${idx} eliminada.` });
                } else sock.sendMessage(remoteJid, { text: "❌ ID inválido." });
            }

            if (command === 'activartarea' || command === 'desactivartarea') {
                let idx = parseInt(args[0]);
                if (db.tasks[idx] !== undefined) {
                    db.tasks[idx].enabled = (command === 'activartarea');
                    saveDB(); iniciarCronJobs(sock);
                    sock.sendMessage(remoteJid, { text: `✅ Tarea ${idx} ${command==='activartarea'?'activada':'desactivada'}.` });
                } else sock.sendMessage(remoteJid, { text: "❌ ID inválido." });
            }

            if (command === 'editartarea') {
                let idx = parseInt(args[0]), nuevoTexto = args.slice(1).join(' ');
                if (!db.tasks[idx]) return sock.sendMessage(remoteJid, { text: "❌ ID inválido." });
                if (nuevoTexto) db.tasks[idx].message = nuevoTexto;
                const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (quoted?.imageMessage) {
                    try {
                        if (db.tasks[idx].mediaPath && fs.existsSync(db.tasks[idx].mediaPath)) fs.unlinkSync(db.tasks[idx].mediaPath);
                        const buffer = await downloadMediaMessage({ key: msg.message.extendedTextMessage.contextInfo.stanzaId, message: quoted }, 'buffer', {});
                        const newPath = `${MEDIA_DIR}/img_${Date.now()}.jpg`;
                        fs.writeFileSync(newPath, buffer);
                        db.tasks[idx].mediaPath = newPath;
                    } catch(e) { return sock.sendMessage(remoteJid, { text: "❌ Error al actualizar imagen." }); }
                }
                saveDB(); iniciarCronJobs(sock);
                sock.sendMessage(remoteJid, { text: `✅ Tarea ${idx} actualizada.` });
            }

            if (command === 'editartiempo') {
                let idx = parseInt(args[0]), timeVal = args[1];
                if (!db.tasks[idx] || !timeVal) return sock.sendMessage(remoteJid, { text: "❌ Uso: !editartiempo [ID] [HH:MM o minutos]" });
                let cronExp, isInterval;
                if (timeVal.includes(':')) { const [h,m] = timeVal.split(':'); cronExp = `${m} ${h} * * *`; isInterval = false; }
                else { cronExp = `*/${timeVal} * * * *`; isInterval = true; }
                db.tasks[idx].cronTime = cronExp; db.tasks[idx].isInterval = isInterval;
                saveDB(); iniciarCronJobs(sock);
                sock.sendMessage(remoteJid, { text: `✅ Horario tarea ${idx} actualizado a ${timeVal}.` });
            }

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

            if (command === 'autoreply') {
                let mode = args[0];
                if (mode === 'on' || mode === 'off') { db.autoReply.active = (mode === 'on'); saveDB(); sock.sendMessage(remoteJid, { text: `✅ Auto-respuesta ${mode.toUpperCase()}.` }); }
                else sock.sendMessage(remoteJid, { text: "Uso: !autoreply on|off" });
            }

            if (command === 'sethoras') {
                let inicio = parseInt(args[0]), fin = parseInt(args[1]);
                if (!isNaN(inicio) && !isNaN(fin)) { db.autoReply.startHour = inicio; db.autoReply.endHour = fin; saveDB(); sock.sendMessage(remoteJid, { text: `✅ Horario dormir: ${inicio}:00 - ${fin}:00.` }); }
                else sock.sendMessage(remoteJid, { text: "Uso: !sethoras [hora_inicio] [hora_fin]" });
            }

            if (command === 'setreplytext') {
                let nuevo = args.join(' ');
                if (nuevo) { db.autoReply.text = nuevo; saveDB(); sock.sendMessage(remoteJid, { text: "✅ Mensaje auto-respuesta actualizado." }); }
                else sock.sendMessage(remoteJid, { text: "Uso: !setreplytext [texto]" });
            }

            if (command === 'loggroups') {
                let mode = args[0];
                if (mode === 'on' || mode === 'off') { db.logGroups = (mode === 'on'); saveDB(); sock.sendMessage(remoteJid, { text: `✅ Registro grupos ${mode.toUpperCase()}.` }); }
                else sock.sendMessage(remoteJid, { text: "Uso: !loggroups on|off" });
            }

            if (command === 'mostrarconfig') {
                let msg = `🔁 Auto-respuesta: ${db.autoReply.active?'ACTIVA':'INACTIVA'}\n⏰ Horario: ${db.autoReply.startHour}:00-${db.autoReply.endHour}:00\n📝 Texto: ${db.autoReply.text}\n📊 Tareas: ${db.tasks.length} (${db.tasks.filter(t=>t.enabled).length} activas)\n📢 Log grupos: ${db.logGroups?'ACTIVO':'INACTIVO'}`;
                sock.sendMessage(remoteJid, { text: msg });
            }
        }
    });
}

// ============================================================================
// 6. SERVIDOR WEB (MUESTRA QR O CÓDIGO DE VINCULACIÓN)
// ============================================================================
app.get('/', (req, res) => {
    if (estaConectado) {
        res.send('<div style="font-family:sans-serif;text-align:center;margin-top:50px;"><h1 style="color:green;">✅ BOT EN LÍNEA</h1><p>El bot está operativo y conectado a WhatsApp.</p></div>');
    } else if (pairingCode) {
        res.send(`
            <div style="font-family:sans-serif;text-align:center;margin-top:50px;">
                <h1>🔢 Código de vinculación</h1>
                <div style="font-size:48px;font-weight:bold;background:#f0f0f0;padding:20px;border-radius:10px;display:inline-block;margin:20px;letter-spacing:2px;">${pairingCode}</div>
                <p>1. Abre WhatsApp en tu teléfono.</p>
                <p>2. Ve a <strong>Dispositivos vinculados</strong>.</p>
                <p>3. Toca <strong>Vincular un dispositivo</strong>.</p>
                <p>4. Ingresa este código para autorizar.</p>
                <p style="color:gray;">La página se actualiza automáticamente...</p>
                <script>setTimeout(() => location.reload(), 5000);</script>
            </div>
        `);
    } else if (qrActual) {
        res.send(`
            <div style="font-family:sans-serif;text-align:center;margin-top:50px;">
                <h1>📱 Escanea el código QR</h1>
                <img src="${qrActual}" style="width:300px;border:1px solid #ccc;padding:10px;border-radius:10px;">
                <p>Abre WhatsApp > Dispositivos vinculados > Vincular un dispositivo</p>
                <script>setTimeout(() => location.reload(), 5000);</script>
            </div>
        `);
    } else {
        res.send('<div style="font-family:sans-serif;text-align:center;margin-top:50px;"><h1>⏳ Inicializando conexión con WhatsApp...</h1><script>setTimeout(()=>location.reload(),3000);</script></div>');
    }
});

app.listen(PORT, () => console.log(`🌐 Servidor web escuchando en el puerto ${PORT}`));

connectToWhatsApp();
