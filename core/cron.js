const cron = require('node-cron');
const { supabaseAdmin } = require('../auth/supabase');
const { instances } = require('./manager');

const TIMEZONE = 'America/Havana';

async function checkAndExecuteTasks() {
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const currentDay = now.getDay(); // 0 = Domingo

  // Obtener todas las configuraciones con tareas activas
  const { data: allSettings, error } = await supabaseAdmin
    .from('bot_settings')
    .select('user_id, data');

  if (error) {
    console.error('Error en cron:', error);
    return;
  }

  for (const record of allSettings) {
    const userId = record.user_id;
    const tasks = record.data.tasks || [];
    
    // Verificar si el usuario tiene una instancia conectada
    const instance = instances.get(userId);
    if (!instance || !instance.isConnected) continue;

    const sock = instance.sock;

    for (const task of tasks) {
      if (!task.active) continue;

      let shouldExecute = false;

      if (task.scheduleType === 'cron') {
        // Para simplificar, usamos una expresión cron compatible
        // (En una implementación real, usaríamos node-cron para cada tarea o una librería como cron-parser)
        // Aquí una versión simple: verificamos si la hora/minuto coincide (para tareas diarias)
        if (task.cronExpression) {
          // Soporte básico: "0 9 * * *" -> minuto 0 hora 9
          const parts = task.cronExpression.split(' ');
          if (parts.length === 5) {
            const minute = parseInt(parts[0]);
            const hour = parseInt(parts[1]);
            if (minute === currentMinute && hour === currentHour) {
              shouldExecute = true;
            }
          }
        }
      } else if (task.scheduleType === 'interval') {
        // Verificar si el intervalo se cumple basado en lastRun
        const nowTime = now.getTime();
        const lastRun = task.lastRun ? new Date(task.lastRun).getTime() : 0;
        const intervalMs = (task.intervalMinutes || 60) * 60 * 1000;
        if (nowTime - lastRun >= intervalMs) {
          shouldExecute = true;
        }
      }

      if (shouldExecute) {
        console.log(`[User ${userId}] Ejecutando tarea: ${task.name}`);
        try {
          let messageContent = {};
          if (task.mediaUrl) {
            // Si hay imagen, enviar con caption
            messageContent = { 
              image: { url: task.mediaUrl },
              caption: task.message 
            };
          } else {
            messageContent = { text: task.message };
          }
          
          await sock.sendMessage(task.target, messageContent);
          
          // Actualizar lastRun
          task.lastRun = now.toISOString();
          // Guardar en DB
          await supabaseAdmin
            .from('bot_settings')
            .update({ data: record.data })
            .eq('user_id', userId);
            
        } catch (err) {
          console.error(`[User ${userId}] Error ejecutando tarea:`, err);
        }
      }
    }
  }
}

function initCron() {
  // Ejecutar cada minuto
  cron.schedule('* * * * *', checkAndExecuteTasks, {
    timezone: TIMEZONE
  });
  console.log('⏰ Cron centralizado iniciado (cada minuto)');
}

module.exports = { initCron };
