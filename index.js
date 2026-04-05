require('dotenv').config();
const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, Browsers, BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

// =======================
// CONFIG
// =======================
const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

let qrActual = '';
let conectado = false;

// =======================
// SUPABASE AUTH (BIEN HECHO)
// =======================
function useSupabaseAuthState(sessionName = 'session') {

    const writeData = async (id, value) => {
        const { error } = await supabase
            .from('whatsapp_sessions')
            .upsert({
                id: `${sessionName}-${id}`,
                session_data: JSON.stringify(value, BufferJSON.replacer)
            });

        if (error) console.error('❌ Error guardando:', error.message);
    };

    const readData = async (id) => {
        const { data, error } = await supabase
            .from('whatsapp_sessions')
            .select('session_data')
            .eq('id', `${sessionName}-${id}`)
            .maybeSingle();

        if (error) {
            console.error('❌ Error leyendo:', error.message);
            return null;
        }

        return data ? JSON.parse(data.session_data, BufferJSON.reviver) : null;
    };

    const removeData = async (id) => {
        await supabase
            .from('whatsapp_sessions')
            .delete()
            .eq('id', `${sessionName}-${id}`);
    };

    return {
        state: {
            creds: initAuthCreds(),

            keys: {
                get: async (type, ids) => {
                    const data = {};

                    for (const id of ids) {
                        let value = await readData(`${type}-${id}`);

                        if (type === 'app-state-sync-key' && value) {
                            try {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            } catch {
                                value = null;
                            }
                        }

                        data[id] = value;
                    }

                    return data;
                },

                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;

                            if (value) {
                                await writeData(key, value);
                            } else {
                                await removeData(key);
                            }
                        }
                    }
                }
            }
        },

        saveCreds: async (creds) => {
            console.log('💾 Guardando sesión...');
            await writeData('creds', creds);
        }
    };
}

// =======================
// WHATSAPP
// =======================
async function startBot() {

    const { state, saveCreds } = useSupabaseAuthState('referi');

    const savedCreds = await (async () => {
        const { data } = await supabase
            .from('whatsapp_sessions')
            .select('session_data')
            .eq('id', 'referi-creds')
            .maybeSingle();

        return data ? JSON.parse(data.session_data, BufferJSON.reviver) : null;
    })();

    if (savedCreds) {
        state.creds = savedCreds;
        console.log('🔑 Sesión cargada desde Supabase');
    } else {
        console.log('🆕 Nueva sesión');
    }

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        keepAliveIntervalMs: 30000,
        markOnlineOnConnect: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrActual = await qrcode.toDataURL(qr);
            console.log('📱 QR generado');
        }

        if (connection === 'open') {
            conectado = true;
            qrActual = '';
            console.log('✅ CONECTADO A WHATSAPP');
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log('⚠️ Desconectado:', code);

            if (code === DisconnectReason.loggedOut) {
                console.log('🧹 Sesión eliminada');

                await supabase
                    .from('whatsapp_sessions')
                    .delete()
                    .like('id', 'referi-%');
            }

            console.log('🔄 Reintentando en 10s...');
            setTimeout(startBot, 10000);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const text = msg.message.conversation || '';

        if (text === '!ping') {
            try {
                await sock.sendMessage(from, { text: 'pong 🧠' });
            } catch (e) {
                console.error('❌ Error enviando mensaje:', e);
            }
        }
    });
}

// =======================
// WEB
// =======================
app.get('/', (req, res) => {
    if (conectado) {
        return res.send('✅ Bot conectado');
    }

    if (qrActual) {
        return res.send(`
            <h2>Escanea el QR</h2>
            <img src="${qrActual}" width="300"/>
            <script>setTimeout(()=>location.reload(),5000)</script>
        `);
    }

    res.send('⏳ Esperando conexión...');
});

app.listen(PORT, () => {
    console.log('🌐 Servidor en puerto', PORT);
    startBot();
});
