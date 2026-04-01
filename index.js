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
const ZONA_HORARIA = "America/Havana"; // Vital para que los cron coincidan con la hora local
const MEDIA_DIR = './media';
const DB_FILE = './database.json';

let qrActual = '';
let estaConectado = false;
let scheduledJobs = {}; // Almacena los procesos de cron activos en memoria

// Crear directorio de medios si no existe (evita errores al guardar fotos)
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
    tasks: [] // Estructura: { targetId, cronTime, message, mediaPath, isInterval, enabled }
};

// Cargar DB al iniciar
if (fs.existsSync(DB_FILE)) {
    try {
        const rawData = fs.readFileSync(DB_FILE);
        db = JSON.parse(rawData);
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
                    // Los estados se envían al broadcast pero requieren definirse como statusJidList
                    await sock.sendMessage('status@broadcast', content, { statusJidList: [sock.user.id] });
                    console.log(`[Cron] Estado automático publicado a las ${new Date().toLocaleTimeString()}`);
                } else {
                    await sock.sendMessage(task.targetId, content);
                    console.log(`[Cron] Mensaje enviado al grupo ${task.targetId}`);
                }
            } catch (error) {
                console.error(`[Error] Fallo al ejecutar la tarea ${index}:`, error);
            }
        }, { timezone: ZONA_HORARIA }); // Aplicar zona horaria a cada tarea individual
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
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }), // Silencia los logs internos de Baileys
        browser: ["REFERI MILLOBET", "Chrome", "20.0.0"] // Identificación del bot
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrActual = await qrcode.toDataURL(qr);
            console.log('>>> NUEVO QR GENERADO. Accede a la web para escanearlo.');
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            estaConectado = false;
            console.log('>>> CONEXIÓN CERRADA. ¿Debe reconectar?:', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 5000); // Esperar 5 seg antes de reconectar
            } else {
                console.log('>>> SESIÓN CERRADA MANUALMENTE DESDE EL TELÉFONO.');
            }
        } else if (connection === 'open') {
            estaConectado = true;
            qrActual = ''; 
            console.log('>>> ¡BOT CONECTADO EXITOSAMENTE!');
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
            }
        }

        // ------------------------------------------------------------------------
        // GESTOR DE COMANDOS (Solo procesa si el mensaje lo envía el dueño)
        // ------------------------------------------------------------------------
        if (isFromMe && textMessage.startsWith('!')) {
            const args = textMessage.slice(1).trim().split(/ +/);
            const command = args.shift().toLowerCase();

            // === COMANDO: !grupos ===
            // Lista todos los grupos con su nombre real y su ID interno
            if (command === 'grupos') {
                const groups = await sock.groupFetchAllParticipating();
                let lista = "*Tus Grupos Activos:*\n";
                Object.values(groups).forEach(g => { 
                    lista += `\n👥 *${g.subject}*\n🆔 \`${g.id}\`\n`; 
                });
                await sock.sendMessage(remoteJid, { text: lista });
            }

            // === COMANDO: !addtask [ID] [Hora o Intervalo] [Texto] ===
            // === COMANDO: !addstatus [Hora o Intervalo] [Texto] ===
            if (command === 'addtask' || command === 'addstatus') {
                const targetId = command === 'addstatus' ? 'status@broadcast' : args[0];
                const timeVal = command === 'addstatus' ? args[0] : args[1];
                const texto = command === 'addstatus' ? args.slice(1).join(' ') : args.slice(2).join(' ');

                if (!targetId || !timeVal || !texto) {
                    return sock.sendMessage(remoteJid, { text: "❌ Formato incorrecto.\nUso: !addtask [ID_Grupo] [HH:MM o Minutos] [Mensaje]" });
                }

                let cronExp;
                let isInterval = false;

                // Detectar si el usuario introdujo una hora exacta (ej. 14:30) o un intervalo (ej. 20)
                if (timeVal.includes(':')) {
                    const [h, m] = timeVal.split(':');
                    cronExp = `${m} ${h} * * *`;
                } else {
                    cronExp = `*/${timeVal} * * * *`;
                    isInterval = true;
                }

                let mediaPath = null;
                const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                
                // Si el mensaje responde a una imagen, descargarla y guardarla
                if (quotedMsg?.imageMessage) {
                    try {
                        const fakeMsg = { key: msg.message.extendedTextMessage.contextInfo.stanzaId, message: quotedMsg };
                        const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        mediaPath = `${MEDIA_DIR}/img_${Date.now()}.jpg`;
                        fs.writeFileSync(mediaPath, buffer);
                    } catch (error) {
                        return sock.sendMessage(remoteJid, { text: "❌ Hubo un error al guardar la imagen de la tarea." });
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
                
                let resText = `✅ Tarea guardada correctamente.\n📍 Destino: ${targetId === 'status@broadcast' ? 'Estados' : 'Grupo'}\n⏱️ Se enviará: ${isInterval ? `Cada ${timeVal} minutos` : `A las ${timeVal} hrs`}.`;
                await sock.sendMessage(remoteJid, { text: resText });
            }

            // === COMANDO: !listartareas ===
            // Muestra todas las tareas programadas indicando si tienen foto
            if (command === 'listartareas') {
                if (db.tasks.length === 0) return sock.sendMessage(remoteJid, { text: "No tienes ninguna tarea programada." });
                
                let res = "*📋 Tareas Programadas:*\n";
                db.tasks.forEach((t, i) => { 
                    const destino = t.targetId === 'status@broadcast' ? '🟢 Estado' : `👥 Grupo`;
                    const foto = t.mediaPath ? '🖼️ Sí' : '📝 Solo texto';
                    res += `\n*ID Tarea: [ ${i} ]*\n📍 Destino: ${destino}\n⏱️ Cron: ${t.cronTime}\n📎 Contiene Foto: ${foto}\n💬 Texto: ${t.message.substring(0,25)}...\n`; 
                });
                await sock.sendMessage(remoteJid, { text: res });
            }

            // === COMANDO: !borrartarea [ID] ===
            if (command === 'borrartarea') {
                const idx = parseInt(args[0]);
                if (db.tasks[idx]) {
                    // Limpieza profunda: Si tenía una foto en el servidor, borrar el archivo para no saturar el disco
                    if (db.tasks[idx].mediaPath && fs.existsSync(db.tasks[idx].mediaPath)) {
                        fs.unlinkSync(db.tasks[idx].mediaPath);
                    }
                    db.tasks.splice(idx, 1); 
                    saveDB(); 
                    iniciarCronJobs(sock);
                    await sock.sendMessage(remoteJid, { text: `✅ Tarea [${idx}] eliminada correctamente.` });
                } else {
                    await sock.sendMessage(remoteJid, { text: "❌ ID de tarea inválido." });
                }
            }

            // === COMANDO: !editartarea [ID] [Nuevo Texto] ===
            // Permite actualizar el texto y la imagen de una tarea existente sin cambiar su horario/grupo
            if (command === 'editartarea') {
                const idx = parseInt(args[0]);
                const nuevoTexto = args.slice(1).join(' ');

                if (!db.tasks[idx]) {
                    return sock.sendMessage(remoteJid, { text: "❌ No existe ninguna tarea con ese ID. Usa !listartareas." });
                }

                if (nuevoTexto) {
                    db.tasks[idx].message = nuevoTexto;
                }

                const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (quotedMsg?.imageMessage) {
                    try {
                        // Borrar la imagen vieja si existía
                        if (db.tasks[idx].mediaPath && fs.existsSync(db.tasks[idx].mediaPath)) {
                            fs.unlinkSync(db.tasks[idx].mediaPath);
                        }
                        
                        // Descargar y guardar la nueva imagen
                        const fakeMsg = { key: msg.message.extendedTextMessage.contextInfo.stanzaId, message: quotedMsg };
                        const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        const newMediaPath = `${MEDIA_DIR}/img_${Date.now()}.jpg`;
                        fs.writeFileSync(newMediaPath, buffer);
                        
                        db.tasks[idx].mediaPath = newMediaPath;
                    } catch (error) {
                        return sock.sendMessage(remoteJid, { text: "❌ Error actualizando la imagen." });
                    }
                }

                saveDB();
                iniciarCronJobs(sock); // Reiniciar el motor para aplicar los cambios en memoria
                await sock.sendMessage(remoteJid, { text: `✅ Tarea [${idx}] actualizada exitosamente.` });
            }

            // === COMANDO: !estado [Texto] ===
            // Publicación manual inmediata a los estados
            if (command === 'estado') {
                const textoEstado = args.join(' ');
                if (msg.message.imageMessage || msg.message.videoMessage) {
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        await sock.sendMessage('status@broadcast', { image: buffer, caption: textoEstado }, { statusJidList: [sock.user.id] });
                        await sock.sendMessage(remoteJid, { text: "✅ Estado con multimedia subido correctamente." });
                    } catch (error) {
                        await sock.sendMessage(remoteJid, { text: "❌ Hubo un error al procesar el archivo multimedia." });
                    }
                } else {
                    await sock.sendMessage('status@broadcast', { text: textoEstado }, { statusJidList: [sock.user.id] });
                    await sock.sendMessage(remoteJid, { text: "✅ Estado subido." });
                }
            }

            // === COMANDOS DE CONFIGURACIÓN DE AUTO-RESPUESTA ===
            if (command === 'autoreply') {
                const mode = args[0];
                if (mode === 'on' || mode === 'off') {
                    db.autoReply.active = (mode === 'on');
                    saveDB();
                    await sock.sendMessage(remoteJid, { text: `✅ Auto-respuesta de inbox configurada en: ${mode.toUpperCase()}` });
                }
            }

            if (command === 'sethoras') {
                const inicio = parseInt(args[0]);
                const fin = parseInt(args[1]);
                if (!isNaN(inicio) && !isNaN(fin)) {
                    db.autoReply.startHour = inicio;
                    db.autoReply.endHour = fin;
                    saveDB();
                    await sock.sendMessage(remoteJid, { text: `✅ Horario de dormir ajustado. De ${inicio}:00 a ${fin}:00.` });
                }
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
