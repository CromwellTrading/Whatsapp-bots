const { supabaseAdmin } = require('./supabase');
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

/**
 * Crea un adaptador de estado de autenticación para un usuario específico
 * @param {string} userId - UUID del usuario en Supabase
 */
async function createSupabaseAuthAdapter(userId) {
  const writeData = async (key, data) => {
    try {
      // Sanitizar: asegurar que los datos sean serializables correctamente
      const sanitized = JSON.parse(JSON.stringify(data, (k, v) => {
        if (v && v.type === 'Buffer' && Array.isArray(v.data)) {
          return Buffer.from(v.data);
        }
        return v;
      }));
      
      const { error } = await supabaseAdmin
        .from('whatsapp_sessions')
        .upsert({ 
          user_id: userId, 
          session_data: { [key]: sanitized },
          updated_at: new Date()
        }, { onConflict: 'user_id' });
      if (error) throw error;
    } catch (err) {
      console.error(`[User ${userId}] Error al guardar ${key}:`, err);
    }
  };

  const readData = async (key) => {
    try {
      const { data, error } = await supabaseAdmin
        .from('whatsapp_sessions')
        .select('session_data')
        .eq('user_id', userId)
        .single();
      if (error) return null;
      const raw = data?.session_data?.[key];
      if (!raw) return null;
      // Reconstruir Buffers si es necesario
      return JSON.parse(JSON.stringify(raw), (k, v) => {
        if (v && v.type === 'Buffer' && Array.isArray(v.data)) {
          return Buffer.from(v.data);
        }
        return v;
      });
    } catch (err) {
      console.error(`[User ${userId}] Error al leer ${key}:`, err);
      return null;
    }
  };

  let creds = (await readData('creds')) || initAuthCreds();
  let keys = (await readData('keys')) || {};

  const saveCreds = async () => {
    await writeData('creds', creds);
  };

  const saveKeys = async () => {
    await writeData('keys', keys);
  };

  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => {
          const key = `${type}-${ids.join('-')}`;
          return Promise.resolve(keys[key] || null);
        },
        set: (data) => {
          for (const key in data) {
            keys[key] = data[key];
          }
          saveKeys();
        },
      },
    },
    saveCreds,
  };
}

module.exports = { createSupabaseAuthAdapter };
