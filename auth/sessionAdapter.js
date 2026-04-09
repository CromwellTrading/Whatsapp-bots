const { supabaseAdmin } = require('./supabase');
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

/**
 * Crea un adaptador de estado de autenticación para un usuario específico
 * @param {string} userId - UUID del usuario en Supabase
 */
async function createSupabaseAuthAdapter(userId) {
  const writeData = async (key, data) => {
    try {
      const { error } = await supabaseAdmin
        .from('whatsapp_sessions')
        .upsert({ 
          user_id: userId, 
          session_data: { [key]: data },
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
      return data?.session_data?.[key] || null;
    } catch (err) {
      console.error(`[User ${userId}] Error al leer ${key}:`, err);
      return null;
    }
  };

  const removeData = async (key) => {
    // No implementamos borrado parcial para evitar perder sesión
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
