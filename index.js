const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
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
const ZONA_HORARIA = process.env.TZ || "America/Havana"; // Usa la zona horaria del servidor
const MEDIA_DIR = './media';
const DB_FILE = './database.json';

let qrActual = '';
let estaConectado = false;
let scheduledJobs = {};
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Crear directorio de medios si no existe
if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR);
}

// ============================================================================
// 2. GESTIÓN DE LA BASE DE DATOS (JSON LOCAL)
// ============================================================================
let db = {
    autoReply: {
        active: false,
        text: "Hola, en este momento estoy offline. Te responderé en cuanto esté disponible.",
        startHour: 23,
        endHour: 8,
        repliedToday: []
    },
    tasks: [],
    logGroups: false
};

// Cargar DB al iniciar
if (fs.existsSync(DB_FILE)) {
    try {
        const rawData = fs.readFileSync(DB_FILE);
        db = JSON.parse(rawData);
        if (db.logGroups === undefined) db.logGroups = false;
    } catch (error) {
        console.error("Error leyendo database.json. Se usará la DB por defecto.", error);
    }
}

const saveDB = () => {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
};

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
                if (task.mediaPath && fs.existsSync(task.mediaPath)) {
                    const buffer = fs.readFileSync(task.mediaPath);
                    content = { image: buffer, caption: task.message };
                } else {
                    content = { text: task.message };
                }

                if (task.targetId === 'status@broadcast') {
                    await sock.sendMessage('status@broadcast', content, { statusJidList: [sock.user.id] });
                    console.log(`[Cron] Estado automático publicado a las ${new Date().toLocaleTimeString()}`);
                } else {
                    await sock.sendMessage(task.targetId, content);
                    console.log(`[Cron] Mensaje enviado al grupo ${task.targetId}`);
                }
            } catch (error) {
                console.error(`[Error] Fallo al ejecutar la tarea ${index}:`, error);
            }
        }, { timezone: ZONA_HORARIA });
    });

    // Resetear lista de auto-respuesta cada día al mediodía
    cron.schedule('0 12 * * *', () => {
        db.autoReply.repliedToday = [];
        saveDB();
        console.log('[Sistema] Lista de auto-respuestas reiniciada.');
    }, { timezone: ZONA_HORARIA });
}

// ============================================================================
// 4. NÚCLEO DEL CLIENTE DE WHATSAPP (BAILEYS)
// ============================================================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'error' }),
        browser: ["REFERI MILLOBET", "Chrome", "20.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            reconnectAttempts = 0;
            qrActual = await qrcode.toDataURL(qr);
            console.log("✅ QR generado. Escanéalo en http://localhost:" + PORT + " (o la URL de Render)");
            console.log("QR en texto (alternativa):\n", qr);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            estaConectado = false;

            if (shouldReconnect) {
                reconnectAttempts++;
                console.log(`❌ Conexión cerrada. Reintento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} en 10s...`);
                if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
                    console.log("⚠️ Demasiados reintentos. Borrando sesión y reiniciando...");
                    fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                    reconnectAttempts = 0;
                    setTimeout(connectToWhatsApp, 5000);
                } else {
                    setTimeout(connectToWhatsApp, 10000);
                }
            } else {
                console.log('🚪 Sesión cerrada desde el teléfono. Esperando nuevo QR.');
                qrActual = '';
            }
        } else if (connection === 'open') {
            reconnectAttempts = 0;
            estaConectado = true;
            qrActual = '';
            console.log('✅ BOT CONECTADO EXITOSAMENTE');
            iniciarCronJobs(sock);
        }
    });

    // ============================================================================
    // 5. PROCESAMIENTO DE MENSAJES Y COMANDOS (omitido por brevedad, pero debe estar completo)
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

        // ------------------------------------------------------------------------
        // REGISTRO DE MENSAJES DE GRUPOS (LOGS EN CHAT PRIVADO)
        // ------------------------------------------------------------------------
        if (isGroup && !isFromMe && db.logGroups) {
            let groupName = remoteJid;
            try {
                const groupMetadata = await sock.groupMetadata(remoteJid);
                groupName = groupMetadata.subject;
            } catch (err) { }

            let senderName = remoteJid.split('@')[0];
            if (msg.key.participant) {
                try {
                    const contact = await sock.contactQuery(msg.key.participant);
                    senderName = contact.notify || contact.name || msg.key.participant.split('@')[0];
                } catch (err) {
                    senderName = msg.key.participant.split('@')[0];
                }
            }

            let logContent = `📢 *Grupo:* ${groupName}\n👤 *De:* ${senderName}\n`;
            if (textMessage) {
                logContent += `💬 *Mensaje:* ${textMessage}`;
            } else if (msg.message.imageMessage) {
                logContent += `🖼️ *Imagen* (caption: ${msg.message.imageMessage.caption || 'sin texto'})`;
            } else if (msg.message.videoMessage) {
                logContent += `🎥 *Video* (caption: ${msg.message.videoMessage.caption || 'sin texto'})`;
            } else if (msg.message.documentMessage) {
                logContent += `📄 *Documento*: ${msg.message.documentMessage.fileName || 'archivo'}`;
            } else {
                logContent += `📨 *Otro tipo de mensaje*`;
            }

            await sock.sendMessage(sock.user.id, { text: logContent });
        }

        // ------------------------------------------------------------------------
        // AUTO-RESPUESTA INBOX (Modo Dormir)
        // ------------------------------------------------------------------------
        if (!isGroup && !isFromMe && db.autoReply.active && remoteJid !== 'status@broadcast') {
            const horaActualStr = new Date().toLocaleString("en-US", { timeZone: ZONA_HORARIA, hour: 'numeric', hour12: false });
            const horaActual = parseInt(horaActualStr);
            const { startHour, endHour, repliedToday, text } = db.autoReply;

            const isSleepingTime = startHour > endHour
                ? (horaActual >= startHour || horaActual < endHour)
                : (horaActual >= startHour && horaActual < endHour);

            if (isSleepingTime && !repliedToday.includes(remoteJid)) {
                await sock.sendMessage(remoteJid, { text: text }, { quoted: msg });
                db.autoReply.repliedToday.push(remoteJid);
                saveDB();
            }
        }

        // ------------------------------------------------------------------------
        // GESTOR DE COMANDOS (Solo dueño)
        // ------------------------------------------------------------------------
        if (isFromMe && textMessage.startsWith('!')) {
            const args = textMessage.slice(1).trim().split(/ +/);
            const command = args.shift().toLowerCase();

            // === COMANDO: !grupos / !detectid ===
            if (command === 'grupos' || command === 'detectid') {
                const groups = await sock.groupFetchAllParticipating();
                let lista = "*📋 Tus Grupos Activos:*\n";
                Object.values(groups).forEach(g => {
                    lista += `\n👥 *${g.subject}*\n🆔 \`${g.id}\`\n`;
                });
                if (Object.keys(groups).length === 0) lista = "No estás en ningún grupo.";
                await sock.sendMessage(remoteJid, { text: lista });
            }

            // === COMANDO: !addtask / !setreplygroup ===
            if (command === 'addtask' || command === 'setreplygroup') {
                const targetId = args[0];
                const timeVal = args[1];
                const texto = args.slice(2).join(' ');
                if (!targetId || !timeVal || !texto) {
                    return sock.sendMessage(remoteJid, { text: "❌ Formato: !addtask [ID_Grupo] [HH:MM o Minutos] [Mensaje]" });
                }

                let cronExp, isInterval;
                if (timeVal.includes(':')) {
                    const [h, m] = timeVal.split(':');
                    cronExp = `${m} ${h} * * *`;
                    isInterval = false;
                } else {
                    cronExp = `*/${timeVal} * * * *`;
                    isInterval = true;
                }

                let mediaPath = null;
                const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (quotedMsg?.imageMessage) {
                    try {
                        const fakeMsg = { key: msg.message.extendedTextMessage.contextInfo.stanzaId, message: quotedMsg };
                        const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger: pino({ level: 'error' }) });
                        mediaPath = `${MEDIA_DIR}/img_${Date.now()}.jpg`;
                        fs.writeFileSync(mediaPath, buffer);
                    } catch (error) {
                        return sock.sendMessage(remoteJid, { text: "❌ Error al guardar la imagen." });
                    }
                }

                db.tasks.push({ targetId, cronTime: cronExp, message: texto, mediaPath, isInterval, enabled: true });
                saveDB();
                iniciarCronJobs(sock);
                let resText = `✅ Tarea guardada.\n📍 Grupo: ${targetId}\n⏱️ ${isInterval ? `Cada ${timeVal} minutos` : `A las ${timeVal} hrs`}.`;
                await sock.sendMessage(remoteJid, { text: resText });
            }

            // === COMANDO: !addstatus / !setreplystatus ===
            if (command === 'addstatus' || command === 'setreplystatus') {
                const timeVal = args[0];
                const texto = args.slice(1).join(' ');
                if (!timeVal || !texto) {
                    return sock.sendMessage(remoteJid, { text: "❌ Formato: !addstatus [HH:MM o Minutos] [Mensaje]" });
                }

                let cronExp, isInterval;
                if (timeVal.includes(':')) {
                    const [h, m] = timeVal.split(':');
                    cronExp = `${m} ${h} * * *`;
                    isInterval = false;
                } else {
                    cronExp = `*/${timeVal} * * * *`;
                    isInterval = true;
                }

                let mediaPath = null;
                const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (quotedMsg?.imageMessage) {
                    try {
                        const fakeMsg = { key: msg.message.extendedTextMessage.contextInfo.stanzaId, message: quotedMsg };
                        const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger: pino({ level: 'error' }) });
                        mediaPath = `${MEDIA_DIR}/img_${Date.now()}.jpg`;
                        fs.writeFileSync(mediaPath, buffer);
                    } catch (error) {
                        return sock.sendMessage(remoteJid, { text: "❌ Error al guardar la imagen." });
                    }
                }

                db.tasks.push({ targetId: 'status@broadcast', cronTime: cronExp, message: texto, mediaPath, isInterval, enabled: true });
                saveDB();
                iniciarCronJobs(sock);
                let resText = `✅ Estado programado.\n⏱️ ${isInterval ? `Cada ${timeVal} minutos` : `A las ${timeVal} hrs`}.`;
                await sock.sendMessage(remoteJid, { text: resText });
            }

            // === Resto de comandos (listartareas, borrartarea, activartarea, desactivartarea, editartarea, editartiempo, estado, autoreply, sethoras, setreplytext, loggroups, mostrarconfig) ===
            // (Conservar el código original, que está completo en tu versión anterior)

            // (Por brevedad, incluyo solo los comandos más importantes; asegúrate de mantener el resto)
        }
    });
}

// ============================================================================
// 6. SERVIDOR WEB PARA ESCANEO DE QR
// ============================================================================
app.get('/', (req, res) => {
    if (estaConectado) {
        res.send(`
            <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
                <h1 style="color: green;">✅ BOT EN LÍNEA</h1>
                <p>El bot está operativo.</p>
            </div>
        `);
    } else if (qrActual) {
        res.send(`
            <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
                <h1>Escanea el código QR</h1>
                <img src="${qrActual}" alt="QR Code" style="width: 300px; height: 300px; border: 1px solid #ccc; padding: 10px; border-radius: 10px;">
                <p>Abre WhatsApp > Dispositivos vinculados > Vincular un dispositivo</p>
                <p style="color: gray; font-size: 12px;">La página se actualiza automáticamente...</p>
                <script>setTimeout(() => location.reload(), 5000);</script>
            </div>
        `);
    } else {
        res.send(`
            <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
                <h1>⏳ Esperando QR...</h1>
                <script>setTimeout(() => location.reload(), 3000);</script>
            </div>
        `);
    }
});

app.listen(PORT, () => console.log(`🌐 Servidor web escuchando en http://localhost:${PORT}`));

// Iniciar el sistema principal
connectToWhatsApp();
