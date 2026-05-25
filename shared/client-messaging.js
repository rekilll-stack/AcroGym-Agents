'use strict';

require('dotenv').config();
const { createLogger }    = require('./logger');
const { sendToAdmin }     = require('./telegram');
const { editMessage, registerCallback } = require('./telegram');
const { getDb }           = require('./db');
const { sendViaWhatsAppCloud } = require('./channels/whatsapp-cloud');

const logger = createLogger('client-messaging');

const LANG_FLAGS = { RU: '🇷🇺', EN: '🇬🇧', AR: '🇶🇦' };
const TYPE_LABELS = {
  greeting:     'Приветствие',
  nurture:      'Прогрев',
  reminder:     'Напоминание клиенту',
  confirmation: 'Подтверждение',
};

// ─────────────────────────────────────────────────────────────
// Таблица client_messages инициализируется в db.js —
// здесь используем готовую функцию getDb()
// ─────────────────────────────────────────────────────────────

function _insertClientMessage({ leadId, messageType, text, language, channel, agentName }) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO client_messages
      (lead_id, message_type, text, language, channel, delivery_status, agent_name)
    VALUES
      (@lead_id, @message_type, @text, @language, @channel, 'queued', @agent_name)
  `).run({ lead_id: leadId, message_type: messageType, text, language, channel, agent_name: agentName });
  return result.lastInsertRowid;
}

function _updateClientMessage(id, updates) {
  const db = getDb();
  const fields = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE client_messages SET ${fields} WHERE id = @id`).run({ ...updates, id });
}

function _getClientMessage(id) {
  return getDb().prepare('SELECT * FROM client_messages WHERE id = ?').get(id);
}

// ─────────────────────────────────────────────────────────────
// РЕЖИМ: telegram_draft
// ─────────────────────────────────────────────────────────────

async function sendDraftToAdmin(lead, messageText, messageType, metadata = {}) {
  const { agentName = 'unknown', leadId } = metadata;
  const channel = 'telegram_draft';

  // 1. Записываем в БД
  const clientMsgId = _insertClientMessage({
    leadId,
    messageType,
    text: messageText,
    language: lead.language,
    channel,
    agentName,
  });

  // 2. Формируем карточку
  const langFlag = LANG_FLAGS[lead.language] || '🌍';
  const typeLabel = TYPE_LABELS[messageType] || messageType;
  const phone = lead.parent_whatsapp || lead.parent_phone || '—';

  const card =
    `📩 <b>Готовое сообщение для клиента</b>\n` +
    `👤 Кому: ${lead.parent_name || '—'}\n` +
    `💬 WhatsApp: ${phone}\n` +
    `${langFlag} Язык: ${lead.language || '—'}\n` +
    `🏷️ Тип: ${typeLabel}\n\n` +
    `──────── СКОПИРОВАТЬ ────────\n` +
    `${messageText}\n` +
    `──────────────────────────────`;

  const keyboard = {
    inline_keyboard: [[
      { text: '📋 Скопировать только текст', callback_data: `copy_text:${clientMsgId}` },
      { text: '✅ Отправил клиенту',         callback_data: `client_sent:${clientMsgId}` },
    ]],
  };

  // 3. Отправляем админу
  const msgs = await sendToAdmin(card, { reply_markup: keyboard });
  const sent = msgs.length > 0;

  _updateClientMessage(clientMsgId, {
    delivery_status: sent ? 'sent_to_admin' : 'failed',
    sent_at: new Date().toISOString(),
  });

  logger.info(
    { clientMsgId, leadId, messageType, sent },
    'Draft-сообщение для клиента отправлено админу'
  );

  return { clientMsgId, msgs };
}

// ─────────────────────────────────────────────────────────────
// ГЛАВНАЯ ФУНКЦИЯ — роутинг по CLIENT_CHANNEL
// ─────────────────────────────────────────────────────────────

/**
 * Отправляет сообщение клиенту через активный канал.
 * Сейчас: telegram_draft (формирует draft для Admin-бота).
 * В будущем: whatsapp_cloud (шлёт напрямую).
 *
 * @param {object} params
 * @param {object} params.lead         - объект лида из БД
 * @param {string} params.messageText  - текст для клиента
 * @param {string} params.messageType  - 'greeting'|'nurture'|'reminder'|'confirmation'
 * @param {object} params.metadata     - { agentName, leadId }
 */
async function sendToClient({ lead, messageText, messageType, metadata = {} }) {
  const channel = process.env.CLIENT_CHANNEL || 'telegram_draft';

  try {
    switch (channel) {
      case 'telegram_draft':
        return await sendDraftToAdmin(lead, messageText, messageType, metadata);
      case 'whatsapp_cloud':
        return await sendViaWhatsAppCloud(lead, messageText, messageType, metadata);
      default:
        throw new Error(`Неизвестный CLIENT_CHANNEL: ${channel}`);
    }
  } catch (err) {
    logger.error({ err, channel, messageType, leadId: metadata.leadId }, 'sendToClient: ошибка отправки');
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Callbacks для inline-кнопок (регистрируются при загрузке модуля)
// ─────────────────────────────────────────────────────────────

registerCallback('copy_text', async (query, bot) => {
  const clientMsgId = parseInt((query.data || '').split(':')[1], 10);
  if (isNaN(clientMsgId)) return;

  const record = _getClientMessage(clientMsgId);
  if (!record) {
    await bot.answerCallbackQuery(query.id, { text: '❌ Сообщение не найдено' });
    return;
  }

  try {
    // Шлём текст отдельным сообщением — удобно зажать и скопировать на мобильном
    await bot.sendMessage(query.message.chat.id, record.text, { parse_mode: 'HTML' });
    await bot.answerCallbackQuery(query.id, { text: '📋 Текст отправлен выше ↑' });
    logger.debug({ clientMsgId }, 'copy_text callback выполнен');
  } catch (err) {
    logger.error({ err, clientMsgId }, 'copy_text callback: ошибка');
    await bot.answerCallbackQuery(query.id, { text: '❌ Ошибка' });
  }
});

registerCallback('client_sent', async (query, bot) => {
  const clientMsgId = parseInt((query.data || '').split(':')[1], 10);
  if (isNaN(clientMsgId)) return;

  try {
    _updateClientMessage(clientMsgId, {
      delivery_status: 'confirmed_sent',
      confirmed_at: new Date().toISOString(),
    });

    const time = new Date().toLocaleTimeString('ru-RU', {
      timeZone: process.env.TIMEZONE || 'Asia/Qatar',
      hour: '2-digit', minute: '2-digit',
    });

    await editMessage(
      'admin',
      query.message.chat.id,
      query.message.message_id,
      query.message.text + `\n\n<b>✅ Отправлено клиенту в ${time}</b>`,
      { reply_markup: { inline_keyboard: [] } }
    );

    await bot.answerCallbackQuery(query.id, { text: '✅ Зафиксировано' });
    logger.info({ clientMsgId }, 'client_sent: подтверждено');
  } catch (err) {
    logger.error({ err, clientMsgId }, 'client_sent callback: ошибка');
    await bot.answerCallbackQuery(query.id, { text: '❌ Ошибка' });
  }
});

module.exports = { sendToClient };
