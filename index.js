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
const ZONA_HORARIA = "America/Havana"; // Cambiar según tu zona horaria
const MEDIA_DIR = './media';
const DB_FILE = './database.json';

let qrActual = '';
let estaConectado = false;
let scheduledJobs = {}; // Almacena los procesos de cron activos en memoria

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
    tasks: [], // Estructura: { targetId, cronTime, message, mediaPath, isInterval, enabled }
    logGroups: false // Nuevo: activar/desactivar registro de mensajes de grupos
};

// Cargar DB al iniciar
if (fs.existsSync(DB_FILE)) {
    try {
        const rawData = fs.readFileSync(DB_FILE);
        db = JSON.parse(rawData);
        // Asegurar que exista la propiedad logGroups
        if (db.logGroups === undefined) db.logGroups = false;
    } catch (error) {
        console.error("Error leyendo database.json. Se usará la DB por defecto.", error);
    }
}

// Función centralizada para guardar cambios en disco
const saveDB = () => {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
};

// ============================================================================
// 3. MOTOR AVANZADO DE TAREAS PROGRAMADAS Y ESTADOS
// ============================================================================
function iniciarCronJobs(sock) {
    // 1. Detener absolutamente todas las tareas anteriores para evitar duplicados
    Object.values(scheduledJobs).forEach(job => job.stop());
    scheduledJobs = {};

    // 2. Recorrer la base de datos y programar las tareas activas
    db.tasks.forEach((task, index) => {
        if (!task.enabled) return;

        scheduledJobs[index] = cron.schedule(task.cronTime, async () => {
            try {
                let content = {};

                // Verificar si la tarea tiene una imagen adjunta y si el archivo aún existe
                if (task.mediaPath && fs.existsSync(task.mediaPath)) {
                    const buffer = fs.readFileSync(task.mediaPath);
                    content = { image: buffer, caption: task.message };
                } else {
                    content = { text: task.message };
                }

                // Enviar el mensaje (Si es estado, requiere formato especial)
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

    // 3. Cron fijo interno: Resetear la lista de personas que ya recibieron auto-respuesta
    // Se ejecuta todos los días al mediodía (12:00 PM)
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
        logger: pino({ level: 'error' }), // Solo mostrar errores importantes
        browser: Browsers.macOS('Desktop') // Conexión estándar para evitar rechazos de WhatsApp
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("✅ QR recibido, generando código para la web...");
            qrActual = await qrcode.toDataURL(qr);
            console.log("Escanea el QR desde la dirección de tu servidor web.");
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            estaConectado = false;
            console.log('CONEXIÓN CERRADA. ¿Debe reconectar?:', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 10000); // Esperar 10 segundos
            } else {
                console.log('SESIÓN CERRADA MANUALMENTE DESDE EL TELÉFONO.');
                // Limpiar la sesión actual si se cierra manualmente
                if (fs.existsSync('./auth_info_baileys')) {
                    fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
                }
            }
        } else if (connection === 'open') {
            estaConectado = true;
            qrActual = '';
            console.log('¡BOT CONECTADO EXITOSAMENTE!');
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

        // Extraer texto dependiendo de si el mensaje tiene imagen, si es citado, o si es texto normal
        const textMessage = msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption || "";

        // ------------------------------------------------------------------------
        // REGISTRO DE MENSAJES DE GRUPOS (LOGS EN CHAT PRIVADO)
        // ------------------------------------------------------------------------
        if (isGroup && !isFromMe && db.logGroups) {
            // Obtener información del grupo (nombre)
            let groupName = remoteJid;
            try {
                const groupMetadata = await sock.groupMetadata(remoteJid);
                groupName = groupMetadata.subject;
            } catch (err) {
                console.error("Error obteniendo metadata del grupo:", err);
            }

            // Obtener nombre del remitente
            let senderName = remoteJid.split('@')[0]; // por defecto el número
            if (msg.key.participant) {
                try {
                    const contact = await sock.contactQuery(msg.key.participant);
                    senderName = contact.notify || contact.name || msg.key.participant.split('@')[0];
                } catch (err) {
                    senderName = msg.key.participant.split('@')[0];
                }
            }

            // Construir contenido del mensaje para el log
            let logContent = `📢 *Grupo:* ${groupName}\n👤 *De:* ${senderName}\n`;

            // Detectar tipo de mensaje
            if (textMessage) {
                logContent += `💬 *Mensaje:* ${textMessage}`;
            } else if (msg.message.imageMessage) {
                logContent += `🖼️ *Imagen* (caption: ${msg.message.imageMessage.caption || 'sin texto'})`;
            } else if (msg.message.videoMessage) {
                logContent += `🎥 *Video* (caption: ${msg.message.videoMessage.caption || 'sin texto'})`;
            } else if (msg.message.documentMessage) {
                logContent += `📄 *Documento*: ${msg.message.documentMessage.fileName || 'archivo'}`;
            } else if (msg.message.audioMessage) {
                logContent += `🎵 *Audio*`;
            } else {
                logContent += `📨 *Otro tipo de mensaje*`;
            }

            // Enviar el log al chat del dueño (su propio número)
            await sock.sendMessage(sock.user.id, { text: logContent });
        }

        // ------------------------------------------------------------------------
        // SISTEMA DE AUTO-RESPUESTA INBOX (Modo Dormir)
        // ------------------------------------------------------------------------
        if (!isGroup && !isFromMe && db.autoReply.active && remoteJid !== 'status@broadcast') {
            const horaActualStr = new Date().toLocaleString("en-US", { timeZone: ZONA_HORARIA, hour: 'numeric', hour12: false });
            const horaActual = parseInt(horaActualStr);
            const { startHour, endHour, repliedToday, text } = db.autoReply;

            // Lógica para detectar si la hora actual está dentro del horario de dormir (cruza medianoche)
            const isSleepingTime = startHour > endHour
                ? (horaActual >= startHour || horaActual < endHour)
                : (horaActual >= startHour && horaActual < endHour);

            if (isSleepingTime && !repliedToday.includes(remoteJid)) {
                await sock.sendMessage(remoteJid, { text: text }, { quoted: msg });
                db.autoReply.repliedToday.push(remoteJid);
                saveDB();
                console.log(`[AutoReply] Respuesta enviada a ${remoteJid}`);
            }
        }

        // ------------------------------------------------------------------------
        // GESTOR DE COMANDOS (Solo procesa si el mensaje lo envía el dueño)
        // ------------------------------------------------------------------------
        if (isFromMe && textMessage.startsWith('!')) {
            const args = textMessage.slice(1).trim().split(/ +/);
            const command = args.shift().toLowerCase();

            // === COMANDO: !grupos (o !detectid) ===
            if (command === 'grupos' || command === 'detectid') {
                const groups = await sock.groupFetchAllParticipating();
                let lista = "*📋 Tus Grupos Activos:*\n";
                Object.values(groups).forEach(g => {
                    lista += `\n👥 *${g.subject}*\n🆔 \`${g.id}\`\n`;
                });
                if (Object.keys(groups).length === 0) lista = "No estás en ningún grupo.";
                await sock.sendMessage(remoteJid, { text: lista });
            }

            // === COMANDO: !addtask [ID_Grupo] [HH:MM o Minutos] [Mensaje] ===
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

                db.tasks.push({
                    targetId,
                    cronTime: cronExp,
                    message: texto,
                    mediaPath,
                    isInterval,
                    enabled: true
                });
                saveDB();
                iniciarCronJobs(sock);

                let resText = `✅ Tarea guardada.\n📍 Grupo: ${targetId}\n⏱️ ${isInterval ? `Cada ${timeVal} minutos` : `A las ${timeVal} hrs`}.`;
                await sock.sendMessage(remoteJid, { text: resText });
            }

            // === COMANDO: !addstatus [HH:MM o Minutos] [Mensaje] ===
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

                db.tasks.push({
                    targetId: 'status@broadcast',
                    cronTime: cronExp,
                    message: texto,
                    mediaPath,
                    isInterval,
                    enabled: true
                });
                saveDB();
                iniciarCronJobs(sock);

                let resText = `✅ Estado programado.\n⏱️ ${isInterval ? `Cada ${timeVal} minutos` : `A las ${timeVal} hrs`}.`;
                await sock.sendMessage(remoteJid, { text: resText });
            }

            // === COMANDO: !listartareas ===
            if (command === 'listartareas') {
                if (db.tasks.length === 0) return sock.sendMessage(remoteJid, { text: "No hay tareas programadas." });
                let res = "*📋 Tareas Programadas:*\n";
                db.tasks.forEach((t, i) => {
                    const destino = t.targetId === 'status@broadcast' ? '🟢 Estado' : `👥 Grupo`;
                    const foto = t.mediaPath ? '🖼️ Sí' : '📝 Solo texto';
                    const estado = t.enabled ? '✅ Activa' : '❌ Inactiva';
                    res += `\n*ID: ${i}* (${estado})\n📍 ${destino}\n⏱️ Cron: ${t.cronTime}\n📎 Foto: ${foto}\n💬 Texto: ${t.message.substring(0, 30)}...\n`;
                });
                await sock.sendMessage(remoteJid, { text: res });
            }

            // === COMANDO: !borrartarea [ID] ===
            if (command === 'borrartarea') {
                const idx = parseInt(args[0]);
                if (db.tasks[idx]) {
                    if (db.tasks[idx].mediaPath && fs.existsSync(db.tasks[idx].mediaPath)) {
                        fs.unlinkSync(db.tasks[idx].mediaPath);
                    }
                    db.tasks.splice(idx, 1);
                    saveDB();
                    iniciarCronJobs(sock);
                    await sock.sendMessage(remoteJid, { text: `✅ Tarea [${idx}] eliminada.` });
                } else {
                    await sock.sendMessage(remoteJid, { text: "❌ ID inválido." });
                }
            }

            // === COMANDO: !activartarea [ID] / !desactivartarea [ID] ===
            if (command === 'activartarea' || command === 'desactivartarea') {
                const idx = parseInt(args[0]);
                if (db.tasks[idx] !== undefined) {
                    const nuevoEstado = (command === 'activartarea');
                    db.tasks[idx].enabled = nuevoEstado;
                    saveDB();
                    iniciarCronJobs(sock);
                    await sock.sendMessage(remoteJid, { text: `✅ Tarea [${idx}] ${nuevoEstado ? 'activada' : 'desactivada'}.` });
                } else {
                    await sock.sendMessage(remoteJid, { text: "❌ ID inválido." });
                }
            }

            // === COMANDO: !editartarea [ID] [nuevo texto] ===
            if (command === 'editartarea') {
                const idx = parseInt(args[0]);
                const nuevoTexto = args.slice(1).join(' ');
                if (db.tasks[idx]) {
                    if (nuevoTexto) db.tasks[idx].message = nuevoTexto;
                    const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (quotedMsg?.imageMessage) {
                        try {
                            if (db.tasks[idx].mediaPath && fs.existsSync(db.tasks[idx].mediaPath)) {
                                fs.unlinkSync(db.tasks[idx].mediaPath);
                            }
                            const fakeMsg = { key: msg.message.extendedTextMessage.contextInfo.stanzaId, message: quotedMsg };
                            const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger: pino({ level: 'error' }) });
                            const newMediaPath = `${MEDIA_DIR}/img_${Date.now()}.jpg`;
                            fs.writeFileSync(newMediaPath, buffer);
                            db.tasks[idx].mediaPath = newMediaPath;
                        } catch (error) {
                            return sock.sendMessage(remoteJid, { text: "❌ Error al actualizar la imagen." });
                        }
                    }
                    saveDB();
                    iniciarCronJobs(sock);
                    await sock.sendMessage(remoteJid, { text: `✅ Tarea [${idx}] actualizada.` });
                } else {
                    await sock.sendMessage(remoteJid, { text: "❌ ID inválido." });
                }
            }

            // === COMANDO: !editartiempo [ID] [HH:MM o Minutos] ===
            if (command === 'editartiempo') {
                const idx = parseInt(args[0]);
                const timeVal = args[1];
                if (db.tasks[idx] && timeVal) {
                    let cronExp, isInterval;
                    if (timeVal.includes(':')) {
                        const [h, m] = timeVal.split(':');
                        cronExp = `${m} ${h} * * *`;
                        isInterval = false;
                    } else {
                        cronExp = `*/${timeVal} * * * *`;
                        isInterval = true;
                    }
                    db.tasks[idx].cronTime = cronExp;
                    db.tasks[idx].isInterval = isInterval;
                    saveDB();
                    iniciarCronJobs(sock);
                    await sock.sendMessage(remoteJid, { text: `✅ Horario de tarea [${idx}] actualizado a ${timeVal}.` });
                } else {
                    await sock.sendMessage(remoteJid, { text: "❌ ID o tiempo inválido." });
                }
            }

            // === COMANDO: !estado [Texto] === (Manual)
            if (command === 'estado') {
                const textoEstado = args.join(' ');
                if (msg.message.imageMessage || msg.message.videoMessage) {
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'error' }) });
                        await sock.sendMessage('status@broadcast', { image: buffer, caption: textoEstado }, { statusJidList: [sock.user.id] });
                        await sock.sendMessage(remoteJid, { text: "✅ Estado con multimedia publicado." });
                    } catch (error) {
                        await sock.sendMessage(remoteJid, { text: "❌ Error al procesar multimedia." });
                    }
                } else {
                    await sock.sendMessage('status@broadcast', { text: textoEstado }, { statusJidList: [sock.user.id] });
                    await sock.sendMessage(remoteJid, { text: "✅ Estado publicado." });
                }
            }

            // === COMANDOS AUTO-RESPUESTA ===
            if (command === 'autoreply') {
                const mode = args[0];
                if (mode === 'on' || mode === 'off') {
                    db.autoReply.active = (mode === 'on');
                    saveDB();
                    await sock.sendMessage(remoteJid, { text: `✅ Auto-respuesta ${mode.toUpperCase()}.` });
                } else {
                    await sock.sendMessage(remoteJid, { text: "Uso: !autoreply on|off" });
                }
            }

            if (command === 'sethoras') {
                const inicio = parseInt(args[0]);
                const fin = parseInt(args[1]);
                if (!isNaN(inicio) && !isNaN(fin)) {
                    db.autoReply.startHour = inicio;
                    db.autoReply.endHour = fin;
                    saveDB();
                    await sock.sendMessage(remoteJid, { text: `✅ Horario de dormir: ${inicio}:00 a ${fin}:00.` });
                } else {
                    await sock.sendMessage(remoteJid, { text: "Uso: !sethoras [hora_inicio] [hora_fin]" });
                }
            }

            if (command === 'setreplytext') {
                const nuevoTexto = args.join(' ');
                if (nuevoTexto) {
                    db.autoReply.text = nuevoTexto;
                    saveDB();
                    await sock.sendMessage(remoteJid, { text: `✅ Mensaje de auto-respuesta actualizado.` });
                } else {
                    await sock.sendMessage(remoteJid, { text: "Uso: !setreplytext [texto]" });
                }
            }

            // === COMANDO: !loggroups on/off ===
            if (command === 'loggroups') {
                const mode = args[0];
                if (mode === 'on' || mode === 'off') {
                    db.logGroups = (mode === 'on');
                    saveDB();
                    await sock.sendMessage(remoteJid, { text: `✅ Registro de grupos ${mode.toUpperCase()}.` });
                } else {
                    await sock.sendMessage(remoteJid, { text: "Uso: !loggroups on|off" });
                }
            }

            // === COMANDO: !mostrarconfig ===
            if (command === 'mostrarconfig') {
                const autoReplyEstado = db.autoReply.active ? 'ACTIVA' : 'INACTIVA';
                const logGroupsEstado = db.logGroups ? 'ACTIVO' : 'INACTIVO';
                let configMsg = `*Configuración actual:*\n\n`;
                configMsg += `🔁 Auto-respuesta: ${autoReplyEstado}\n`;
                configMsg += `⏰ Horario dormir: ${db.autoReply.startHour}:00 - ${db.autoReply.endHour}:00\n`;
                configMsg += `📝 Texto: ${db.autoReply.text}\n`;
                configMsg += `📊 Tareas totales: ${db.tasks.length}\n`;
                const activas = db.tasks.filter(t => t.enabled).length;
                configMsg += `⚙️ Activas: ${activas}\n`;
                configMsg += `📢 Registro de grupos: ${logGroupsEstado}\n`;
                await sock.sendMessage(remoteJid, { text: configMsg });
            }
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
                <h1 style="color: green;">✅ REFERI MILLOBET está en línea</h1>
                <p>El bot está operativo y esperando comandos.</p>
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
                <h1>⏳ Generando QR de acceso...</h1>
                <script>setTimeout(() => location.reload(), 3000);</script>
            </div>
        `);
    }
});

app.listen(PORT, () => console.log(`🌐 Servidor web escuchando en el puerto ${PORT}`));

// Iniciar el sistema principal
connectToWhatsApp();
