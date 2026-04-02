const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_PHONE_NUMBER = process.env.BOT_PHONE_NUMBER || null; // Asegúrate de que no tenga el '+' (ej: 5359190241)

let qrActual = '';
let pairingCode = null;
let estaConectado = false;

// Inicializamos el cliente con Chrome invisible
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './auth_wwebjs' }),
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

// EVENTO: Generación de QR o Código
client.on('qr', async (qr) => {
    console.log('🔄 Esperando vinculación...');
    
    if (BOT_PHONE_NUMBER) {
        try {
            // Pedimos el código de 8 dígitos
            const code = await client.requestPairingCode(BOT_PHONE_NUMBER);
            pairingCode = code;
            console.log(`\n=========================================\n🔢 TU CÓDIGO DE VINCULACIÓN: ${pairingCode}\n=========================================\n`);
        } catch (error) {
            console.error('❌ Error pidiendo código:', error.message);
        }
    } else {
        qrActual = await qrcode.toDataURL(qr);
    }
});

// EVENTO: Conexión Exitosa
client.on('ready', () => {
    console.log('✅ BOT REFERI MILLOBET CONECTADO EXITOSAMENTE');
    estaConectado = true;
    qrActual = '';
    pairingCode = null;
});

// EVENTO: Sesión cerrada o desconectada
client.on('disconnected', (reason) => {
    console.log('❌ Bot desconectado:', reason);
    estaConectado = false;
    client.initialize(); // Reintenta conectar
});

// ==========================================================
// TEST DE COMANDOS
// ==========================================================
client.on('message_create', async msg => {
    const isFromMe = msg.fromMe;
    
    // Solo responde a ti mismo si escribes !ping
    if (isFromMe && msg.body === '!ping') {
        msg.reply('✅ Pong! El bot está vivo y leyendo comandos.');
    }
});

// Iniciar WhatsApp
client.initialize();

// ==========================================================
// SERVIDOR WEB
// ==========================================================
app.get('/', (req, res) => {
    if (estaConectado) {
        res.send('<div style="font-family:sans-serif;text-align:center;margin-top:50px;"><h1 style="color:green;">✅ BOT EN LÍNEA</h1><p>Conectado a WhatsApp con éxito.</p></div>');
    } else if (pairingCode) {
        res.send(`
            <div style="font-family:sans-serif;text-align:center;margin-top:50px;">
                <h1>🔢 Código de vinculación</h1>
                <div style="font-size:48px;font-weight:bold;background:#f0f0f0;padding:20px;border-radius:10px;display:inline-block;margin:20px;letter-spacing:2px;">${pairingCode}</div>
                <p>1. Abre WhatsApp > Dispositivos vinculados > Vincular un dispositivo</p>
                <p>2. Ingresa este código.</p>
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
        res.send('<div style="font-family:sans-serif;text-align:center;margin-top:50px;"><h1>⏳ Levantando el navegador Chrome interno...</h1><script>setTimeout(()=>location.reload(),3000);</script></div>');
    }
});

app.listen(PORT, () => console.log(`🌐 Servidor web escuchando en puerto ${PORT}`));
