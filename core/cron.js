const cron = require('node-cron');
const { supabaseAdmin } = require('../auth/supabase');
const { instances } = require('./manager');

const TIMEZONE = 'America/Havana';

async function checkAndExecuteTasks() {
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  const { data: allSettings, error } = await supabaseAdmin
    .from('bot_settings')
    .select('user_id, data');

  if (error) return console.error('Error en cron:', error);

  for (const record of allSettings) {
    const userId = record.user_id;
    const data = record.data;
    const allTasks = [...(data.tasks || []), ...(data.statusTasks || [])];
    
    const instance = instances.get(userId);
    if (!instance || !instance.isConnected) continue;

    for (const task of allTasks) {
      if (!task.active) continue;
      let shouldExecute = false;

      if (task.scheduleType === 'cron' && task.cronExpression) {
        const [minute, hour] = task.cronExpression.split(' ');
        if (parseInt(minute) === currentMinute && parseInt(hour) === currentHour) {
          shouldExecute = true;
        }
      } else if (task.scheduleType === 'interval') {
        const lastRun = task.lastRun ? new Date(task.lastRun).getTime() : 0;
        const intervalMs = (task.intervalMinutes || 60) * 60 * 1000;
        if (now.getTime() - lastRun >= intervalMs) {
          shouldExecute = true;
        }
      }

      if (shouldExecute) {
        console.log(`[User ${userId}] Ejecutando tarea: ${task.name}`);
        try {
          let messageContent = {};
          if (task.mediaUrl) {
            messageContent = { 
              image: { url: task.mediaUrl },
              caption: task.message 
            };
          } else {
            messageContent = { text: task.message };
          }
          await instance.sock.sendMessage(task.target, messageContent);
          task.lastRun = now.toISOString();
        } catch (err) {
          console.error(`[User ${userId}] Error ejecutando tarea:`, err);
        }
      }
    }
    
    // Guardar lastRun actualizado
    await supabaseAdmin.from('bot_settings').update({ data }).eq('user_id', userId);
  }
}

function initCron() {
  cron.schedule('* * * * *', checkAndExecuteTasks, { timezone: TIMEZONE });
  console.log('⏰ Cron centralizado iniciado (cada minuto)');
}

module.exports = { initCron };
