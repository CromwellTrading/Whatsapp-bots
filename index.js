require('dotenv').config();
const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const cron = require('node-cron');

// ============================================================================
// 1. CONFIGURACIÓN DEL ENTORNO
// ============================================================================
const app = express();
const PORT = process.env.PORT || 3000;
const ZONA_HORARIA = process.env.TZ || "America/Havana";
const MEDIA_DIR = './media';
const BOT_PHONE_NUMBER = process.env.BOT_PHONE_NUMBER || null;

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);

// ============================================================================
// 2. CONEXIÓN A SUPABASE Y CUSTOM STORE PARA SESIÓN
// ============================================================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

let db = null; // Almacenará la config traída de Supabase
const saveDB = () => supabase.from('bot_settings').update({ data: db }).eq('id', 'default_config').then();

// Adaptador para guardar el .zip de la sesión de WhatsApp en PostgreSQL
class SupabaseStore {
    constructor(client) { this.supabase = client; }
    
    async sessionExists({ session }) {
        const { data } = await this.supabase.from('whatsapp_sessions').select('id').eq('id', session).maybeSingle();
        return !!data;
    }
    
    async save({ session }) {
        const zipPath = `${session}.zip`;
        if (!fs.existsSync(zipPath)) return;
        const buffer = fs.readFileSync(zipPath);
        const base64Data = buffer.toString('base64');
        await this.supabase.from('whatsapp_sessions').upsert({ id: session, session_data: base64Data });
        console.log('💾 Sesión empaquetada y respaldada en Supabase.');
    }
    
    async extract({ session }) {
        const { data } = await this.supabase.from('whatsapp_sessions').select('session_data').eq('id', session).maybeSingle();
        if (data && data.session_data) {
            fs.writeFileSync(`${session}.zip`, Buffer.from(data.session_data, 'base64'));
            console.log('📦 Sesión descargada y extraída de Supabase.');
        }
    }
    
    async delete({ session }) {
        await this.supabase.from('whatsapp_sessions').delete().eq('id', session);
    }
}

// ============================================================================
// 3. ESTADOS GLOBALES Y CRON JOBS
// ============================================================================
let qrActual = '';
let pairingCode = null;
let estaConectado = false;
let scheduledJobs = {};

function iniciarCronJobs(client) {
    Object.values(scheduledJobs).forEach(job => job.stop());
    scheduledJobs = {};
    
    db.tasks.forEach((task, index) => {
        if (!task.enabled) return;
        scheduledJobs[index] = cron.schedule(task.cronTime, async () => {
            try {
                let options = {};
                if (task.mediaPath && fs.existsSync(task.mediaPath)) {
                    const media = MessageMedia.fromFilePath(task.mediaPath);
                    if (task.targetId === 'status@broadcast') {
                        await client.sendMessage('status@broadcast', media, { caption: task.message });
                    } else {
                        await client.sendMessage(task.targetId, media, { caption: task.message });
                    }
                } else {
                    await client.sendMessage(task.targetId, task.message);
                }
            } catch(e) { console.error("Error en tarea cron:", e); }
        }, { timezone: ZONA_HORARIA });
    });

    // Resetear auto-respuestas diarias al mediodía
    cron.schedule('0 12 * * *', () => { 
        db.autoReply.repliedToday = []; 
        saveDB(); 
    }, { timezone: ZONA_HORARIA });
}

// ============================================================================
// 4. INICIALIZACIÓN DEL NÚCLEO (WHATSAPP WEB JS)
// ============================================================================
async function iniciarBot() {
    // Cargar config inicial desde Supabase
    const { data: configData } = await supabase.from('bot_settings').select('data').eq('id', 'default_config').single();
    db = configData.data;

    const store = new SupabaseStore(supabase);

    const client = new Client({
        authStrategy: new RemoteAuth({
            store: store,
            backupSyncIntervalMs: 300000 // Respaldo cada 5 min
        }),
        puppeteer: {
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        }
    });

    client.on('qr', async (qr) => {
        console.log('🔄 Esperando vinculación...');
        if (BOT_PHONE_NUMBER) {
            try {
                pairingCode = await client.requestPairingCode(BOT_PHONE_NUMBER);
                console.log(`\n=========================================\n🔢 TU CÓDIGO DE VINCULACIÓN: ${pairingCode}\n=========================================\n`);
            } catch (err) { console.error('❌ Error código:', err.message); }
        } else {
            qrActual = await qrcode.toDataURL(qr);
        }
    });

    client.on('ready', () => {
        console.log('✅ BOT REFERI MILLOBET CONECTADO EXITOSAMENTE');
        estaConectado = true; qrActual = ''; pairingCode = null;
        iniciarCronJobs(client);
    });

    client.on('disconnected', (reason) => {
        console.log('❌ Bot desconectado:', reason);
        estaConectado = false;
        client.initialize(); 
    });

    // ============================================================================
    // 5. PROCESAMIENTO DE MENSAJES Y COMANDOS (ADAPTADO)
    // ============================================================================
    client.on('message_create', async (msg) => {
        const isFromMe = msg.fromMe;
        const remoteJid = msg.to; // En wwebjs el destino suele ser 'to' si eres el autor, o 'from' si lo recibes
        const chatId = isFromMe ? msg.to : msg.from;
        const isGroup = chatId.endsWith('@g.us');
        const textMessage = msg.body || "";

        // ========== REGISTRO DE GRUPOS ==========
        if (isGroup && !isFromMe && db.logGroups) {
            let logContent = `📢 *Grupo:* ${(await msg.getChat()).name}\n👤 *De:* ${msg.author || msg.from}\n`;
            if (textMessage) logContent += `💬 *Mensaje:* ${textMessage}`;
            else if (msg.hasMedia) logContent += `🖼️/🎥 *Archivo Multimedia*`;
            else logContent += `📨 *Otro*`;
            await client.sendMessage(client.info.wid._serialized, logContent);
        }

        // ========== AUTO-RESPUESTA ==========
        if (!isGroup && !isFromMe && db.autoReply.active && chatId !== 'status@broadcast') {
            const hora = parseInt(new Date().toLocaleString("en-US", { timeZone: ZONA_HORARIA, hour: 'numeric', hour12: false }));
            const { startHour, endHour, repliedToday, text } = db.autoReply;
            const sleeping = startHour > endHour ? (hora >= startHour || hora < endHour) : (hora >= startHour && hora < endHour);
            if (sleeping && !repliedToday.includes(chatId)) {
                await msg.reply(text);
                db.autoReply.repliedToday.push(chatId);
                saveDB();
            }
        }

        // ========== GESTOR DE COMANDOS (SOLO DUEÑO) ==========
        if (isFromMe && textMessage.startsWith('!')) {
            const args = textMessage.slice(1).trim().split(/ +/);
            const command = args.shift().toLowerCase();

            // --- !grupos / !detectid ---
            if (command === 'grupos' || command === 'detectid') {
                const chats = await client.getChats();
                const groups = chats.filter(c => c.isGroup);
                let lista = "*📋 Tus Grupos Activos:*\n";
                groups.forEach(g => lista += `\n👥 *${g.name}*\n🆔 \`${g.id._serialized}\`\n`);
                await client.sendMessage(chatId, lista || "No estás en ningún grupo.");
            }

            // --- !addtask / !setreplygroup ---
            if (command === 'addtask' || command === 'setreplygroup') {
                const targetId = args[0], timeVal = args[1], texto = args.slice(2).join(' ');
                if (!targetId || !timeVal || !texto) return msg.reply("❌ Formato: !addtask [ID] [HH:MM o minutos] [mensaje]");
                
                let cronExp, isInterval;
                if (timeVal.includes(':')) { const [h,m] = timeVal.split(':'); cronExp = `${m} ${h} * * *`; isInterval = false; }
                else { cronExp = `*/${timeVal} * * * *`; isInterval = true; }
                
                let mediaPath = null;
                if (msg.hasQuotedMsg) {
                    const quoted = await msg.getQuotedMessage();
                    if (quoted.hasMedia) {
                        const media = await quoted.downloadMedia();
                        mediaPath = `${MEDIA_DIR}/img_${Date.now()}.${media.mimetype.split('/')[1]}`;
                        fs.writeFileSync(mediaPath, Buffer.from(media.data, 'base64'));
                    }
                }
                
                db.tasks.push({ targetId, cronTime: cronExp, message: texto, mediaPath, isInterval, enabled: true });
                saveDB(); iniciarCronJobs(client);
                msg.reply(`✅ Tarea guardada. ${isInterval ? `Cada ${timeVal} min` : `A las ${timeVal}`}`);
            }

            // --- !addstatus / !setreplystatus ---
            if (command === 'addstatus' || command === 'setreplystatus') {
                const timeVal = args[0], texto = args.slice(1).join(' ');
                if (!timeVal || !texto) return msg.reply("❌ Formato: !addstatus [HH:MM o minutos] [mensaje]");
                
                let cronExp, isInterval;
                if (timeVal.includes(':')) { const [h,m] = timeVal.split(':'); cronExp = `${m} ${h} * * *`; isInterval = false; }
                else { cronExp = `*/${timeVal} * * * *`; isInterval = true; }
                
                let mediaPath = null;
                if (msg.hasQuotedMsg) {
                    const quoted = await msg.getQuotedMessage();
                    if (quoted.hasMedia) {
                        const media = await quoted.downloadMedia();
                        mediaPath = `${MEDIA_DIR}/img_${Date.now()}.${media.mimetype.split('/')[1]}`;
                        fs.writeFileSync(mediaPath, Buffer.from(media.data, 'base64'));
                    }
                }
                
                db.tasks.push({ targetId: 'status@broadcast', cronTime: cronExp, message: texto, mediaPath, isInterval, enabled: true });
                saveDB(); iniciarCronJobs(client);
                msg.reply(`✅ Estado programado. ${isInterval ? `Cada ${timeVal} min` : `A las ${timeVal}`}`);
            }

            // --- !listartareas ---
            if (command === 'listartareas') {
                if (!db.tasks.length) return msg.reply("No hay tareas.");
                let res = "*📋 Tareas Programadas:*\n";
                db.tasks.forEach((t,i) => {
                    const destino = t.targetId === 'status@broadcast' ? '🟢 Estado' : '👥 Grupo';
                    const foto = t.mediaPath ? '🖼️ Sí' : '📝 Solo texto';
                    const estado = t.enabled ? '✅ Activa' : '❌ Inactiva';
                    res += `\n*ID ${i}* (${estado})\n📍 ${destino}\n⏱️ Cron: ${t.cronTime}\n📎 Foto: ${foto}\n💬 Texto: ${t.message.substring(0,30)}...\n`;
                });
                msg.reply(res);
            }

            // --- !borrartarea [ID] ---
            if (command === 'borrartarea') {
                let idx = parseInt(args[0]);
                if (db.tasks[idx]) {
                    if (db.tasks[idx].mediaPath && fs.existsSync(db.tasks[idx].mediaPath)) fs.unlinkSync(db.tasks[idx].mediaPath);
                    db.tasks.splice(idx,1);
                    saveDB(); iniciarCronJobs(client);
                    msg.reply(`✅ Tarea ${idx} eliminada.`);
                } else msg.reply("❌ ID inválido.");
            }

            // --- !activartarea / !desactivartarea [ID] ---
            if (command === 'activartarea' || command === 'desactivartarea') {
                let idx = parseInt(args[0]);
                if (db.tasks[idx] !== undefined) {
                    db.tasks[idx].enabled = (command === 'activartarea');
                    saveDB(); iniciarCronJobs(client);
                    msg.reply(`✅ Tarea ${idx} ${command==='activartarea'?'activada':'desactivada'}.`);
                } else msg.reply("❌ ID inválido.");
            }

            // --- !estado [texto] (manual) ---
            if (command === 'estado') {
                let texto = args.join(' ');
                if (msg.hasMedia) {
                    const media = await msg.downloadMedia();
                    await client.sendMessage('status@broadcast', media, { caption: texto });
                    msg.reply("✅ Estado con imagen publicado.");
                } else {
                    await client.sendMessage('status@broadcast', texto);
                    msg.reply("✅ Estado publicado.");
                }
            }

            // --- Comandos de configuración ---
            if (command === 'autoreply') {
                let mode = args[0];
                if (mode === 'on' || mode === 'off') { db.autoReply.active = (mode === 'on'); saveDB(); msg.reply(`✅ Auto-respuesta ${mode.toUpperCase()}.`); }
            }
            if (command === 'sethoras') {
                let inicio = parseInt(args[0]), fin = parseInt(args[1]);
                if (!isNaN(inicio) && !isNaN(fin)) { db.autoReply.startHour = inicio; db.autoReply.endHour = fin; saveDB(); msg.reply(`✅ Horario dormir: ${inicio}:00 - ${fin}:00.`); }
            }
            if (command === 'setreplytext') {
                let nuevo = args.join(' ');
                if (nuevo) { db.autoReply.text = nuevo; saveDB(); msg.reply("✅ Mensaje auto-respuesta actualizado."); }
            }
            if (command === 'loggroups') {
                let mode = args[0];
                if (mode === 'on' || mode === 'off') { db.logGroups = (mode === 'on'); saveDB(); msg.reply(`✅ Registro grupos ${mode.toUpperCase()}.`); }
            }
            if (command === 'mostrarconfig') {
                let msj = `🔁 Auto-respuesta: ${db.autoReply.active?'ACTIVA':'INACTIVA'}\n⏰ Horario: ${db.autoReply.startHour}:00-${db.autoReply.endHour}:00\n📝 Texto: ${db.autoReply.text}\n📊 Tareas: ${db.tasks.length} (${db.tasks.filter(t=>t.enabled).length} activas)\n📢 Log grupos: ${db.logGroups?'ACTIVO':'INACTIVO'}`;
                msg.reply(msj);
            }
        }
    });

    client.initialize();
}

iniciarBot();

// ============================================================================
// 6. SERVIDOR WEB
// ============================================================================
app.get('/', (req, res) => {
    if (estaConectado) {
        res.send('<div style="font-family:sans-serif;text-align:center;margin-top:50px;"><h1 style="color:green;">✅ REFERI MILLOBET EN LÍNEA</h1><p>Conectado a WhatsApp y sesión respaldada en Supabase.</p></div>');
    } else if (pairingCode) {
        res.send(`
            <div style="font-family:sans-serif;text-align:center;margin-top:50px;">
                <h1>🔢 Código de vinculación</h1>
                <div style="font-size:48px;font-weight:bold;background:#f0f0f0;padding:20px;border-radius:10px;display:inline-block;margin:20px;letter-spacing:2px;">${pairingCode}</div>
                <p>Ingresa este código en WhatsApp.</p>
                <script>setTimeout(() => location.reload(), 5000);</script>
            </div>
        `);
    } else if (qrActual) {
        res.send(`
            <div style="font-family:sans-serif;text-align:center;margin-top:50px;">
                <h1>📱 Escanea el código QR</h1>
                <img src="${qrActual}" style="width:300px;border:1px solid #ccc;padding:10px;border-radius:10px;">
                <script>setTimeout(() => location.reload(), 5000);</script>
            </div>
        `);
    } else {
        res.send('<div style="font-family:sans-serif;text-align:center;margin-top:50px;"><h1>⏳ Extrayendo datos desde Supabase e iniciando sistema...</h1><script>setTimeout(()=>location.reload(),3000);</script></div>');
    }
});

app.listen(PORT, () => console.log(`🌐 Servidor web escuchando en puerto ${PORT}`));
