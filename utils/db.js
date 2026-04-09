const { supabaseAdmin } = require('../auth/supabase');

async function getSettings(userId) {
  const { data, error } = await supabaseAdmin
    .from('bot_settings')
    .select('data')
    .eq('user_id', userId)
    .single();
  
  if (error) return null;
  return data.data;
}

async function saveSettings(userId, settings) {
  const { error } = await supabaseAdmin
    .from('bot_settings')
    .upsert({ user_id: userId, data: settings }, { onConflict: 'user_id' });
  
  if (error) throw error;
  return true;
}

module.exports = { getSettings, saveSettings };
