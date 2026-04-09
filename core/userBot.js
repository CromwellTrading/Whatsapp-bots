const { getSettings } = require('../utils/db');
const { supabaseAdmin } = require('../auth/supabase');

function createUserBot(userId, sock) {
  
  async function handleMessages(messages) {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

    console.log(`[User ${userId}] Mensaje de ${sender}: ${messageContent}`);

    // Ignorar grupos para auto-reply (a menos que el usuario lo configure, por ahora solo privado)
    if (sender.endsWith('@g.us')) return;

    const settings = await getSettings(userId);
    if (!settings) return;

    const autoReply = settings.autoReply;

    if (autoReply?.active) {
      const now = new Date();
      const currentHour = now.getHours();
      const isWithinQuietHours = 
        (autoReply.startHour > autoReply.endHour && (currentHour >= autoReply.startHour || currentHour < autoReply.endHour)) ||
        (autoReply.startHour <= autoReply.endHour && currentHour >= autoReply.startHour && currentHour < autoReply.endHour);

      if (isWithinQuietHours) {
        await sock.sendMessage(sender, { text: autoReply.text });
      }
    }

    // Comandos personalizados
    if (messageContent.toLowerCase() === '!ping') {
      await sock.sendMessage(sender, { text: 'pong' });
    }

    if (messageContent.toLowerCase() === '!listgroups') {
      try {
        const groups = await sock.groupFetchAllParticipating();
        let groupList = '📋 *Grupos:*\n\n';
        for (const id in groups) {
          groupList += `- ${groups[id].subject} (${id})\n`;
        }
        await sock.sendMessage(sender, { text: groupList });
      } catch (err) {
        await sock.sendMessage(sender, { text: '❌ Error al obtener grupos.' });
      }
    }
  }

  return { handleMessages };
}

module.exports = { createUserBot };
