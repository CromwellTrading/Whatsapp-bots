const cron = require('node-cron');
const { supabaseAdmin } = require('../auth/supabase');
const { instances } = require('./manager');

const TIMEZONE = 'America/Havana';

function getNowInHavana() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(now);

  let hour = 0, minute = 0;
  for (const p of parts) {
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  // Intl can return 24 for midnight
  if (hour === 24) hour = 0;
  return { hour, minute };
}

async function checkAndExecuteTasks() {
  const { hour: currentHour, minute: currentMinute } = getNowInHavana();

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

    let changed = false;

    for (const task of allTasks) {
      if (!task.active) continue;
      let shouldExecute = false;

      if (task.scheduleType === 'cron' && task.cronExpression) {
        // cronExpression stored as "minute hour" (e.g. "30 14")
        const parts = task.cronExpression.split(' ');
        const taskMinute = parseInt(parts[0], 10);
        let taskHour = parseInt(parts[1], 10);
        // treat 24 as 0 (military midnight)
        if (taskHour === 24) taskHour = 0;
        if (taskMinute === currentMinute && taskHour === currentHour) {
          shouldExecute = true;
        }
      } else if (task.scheduleType === 'interval') {
        const lastRun = task.lastRun ? new Date(task.lastRun).getTime() : 0;
        const intervalMs = (task.intervalMinutes || 60) * 60 * 1000;
        if (Date.now() - lastRun >= intervalMs) {
          shouldExecute = true;
        }
      }

      if (shouldExecute) {
        console.log(`[Cron][User ${userId}] Ejecutando tarea: ${task.name}`);
        try {
          let messageContent;
          if (task.mediaUrl) {
            messageContent = { image: { url: task.mediaUrl }, caption: task.message || '' };
          } else {
            messageContent = { text: task.message };
          }

          const target = task.target || 'status@broadcast';
          await instance.sock.sendMessage(target, messageContent);
          task.lastRun = new Date().toISOString();
          changed = true;
        } catch (err) {
          console.error(`[Cron][User ${userId}] Error ejecutando tarea "${task.name}":`, err.message);
        }
      }
    }

    if (changed) {
      await supabaseAdmin.from('bot_settings').update({ data }).eq('user_id', userId);
    }
  }
}

function initCron() {
  cron.schedule('* * * * *', checkAndExecuteTasks, { timezone: TIMEZONE });
  console.log('Cron centralizado iniciado (cada minuto) — Zona: ' + TIMEZONE);
}

module.exports = { initCron };
