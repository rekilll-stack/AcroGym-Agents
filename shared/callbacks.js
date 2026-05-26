'use strict';

/**
 * shared/callbacks.js — центральные обработчики inline-кнопок.
 * Используются как в lead-helper (ADMIN_BOT), так и в morning-digest (OWNER_BOT).
 * Логика одна — бот указывается параметром.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const dayjs    = require('dayjs');
const utc      = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const { createLogger }                  = require('./logger');
const { getLeadById, updateLeadStatus } = require('./db');
const { editMessage }                   = require('./telegram');

const logger   = createLogger('callbacks');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Qatar';

// ─────────────────────────────────────────────────────────────
// markRespondedHandler
// ─────────────────────────────────────────────────────────────

/**
 * Обработчик "✅ Mark responded" / "✅ I responded" / "✅ Contacted".
 * Работает для префиксов 'responded' (lead-helper) и 'mark_responded' (morning-digest).
 *
 * @param {'admin'|'owner'} botName  — через какой бот было отправлено исходное сообщение
 * @returns {Function} handler(query, bot)
 */
function markRespondedHandler(botName) {
  return async (query, bot) => {
    const leadId = parseInt((query.data || '').split(':')[1], 10);
    if (isNaN(leadId)) {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    try {
      const lead = getLeadById(leadId);

      if (lead && lead.status !== 'responded') {
        updateLeadStatus(lead.sheet_row_number, {
          status:       'responded',
          responded_at: new Date().toISOString(),
        });
        logger.info({ leadId, sheetRow: lead.sheet_row_number }, 'Lead marked as responded');
      }

      const time = dayjs().tz(TIMEZONE).format('HH:mm');

      // Редактируем исходное сообщение: убираем кнопки, добавляем строку с временем
      const originalText = query.message.text || query.message.caption || '';
      await editMessage(
        botName,
        query.message.chat.id,
        query.message.message_id,
        originalText + `\n\n✅ Marked responded at ${time} (Doha)`,
        { reply_markup: { inline_keyboard: [] } }
      );

      await bot.answerCallbackQuery(query.id, { text: '✅ Marked as responded' });
    } catch (err) {
      logger.error({ err, leadId }, 'Error in markResponded callback');
      try { await bot.answerCallbackQuery(query.id, { text: '❌ Error updating lead' }); } catch {}
    }
  };
}

// ─────────────────────────────────────────────────────────────
// copyTextHandler
// ─────────────────────────────────────────────────────────────

/**
 * Обработчик "📋 Copy text only" / "📋 Copy text".
 * Достаёт generated_greeting из БД, шлёт отдельным сообщением (без обвески).
 *
 * Работает для префиксов 'copy' (lead-helper) и 'copy_text' / 'digest_copy' (morning-digest).
 *
 * @param {Map|null} [greetingCache]  — опциональный in-memory fallback (из lead-helper)
 * @returns {Function} handler(query, bot)
 */
function copyTextHandler(greetingCache = null) {
  return async (query, bot) => {
    const leadId = (query.data || '').split(':')[1];
    if (!leadId) {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    try {
      // Сначала ищем в БД
      const lead = getLeadById(parseInt(leadId, 10));
      let text = lead?.generated_greeting || null;

      // Fallback → in-memory cache (lead-helper)
      if (!text && greetingCache) {
        text = greetingCache.get(leadId) || null;
      }

      if (text) {
        await bot.sendMessage(query.message.chat.id, text);
        await bot.answerCallbackQuery(query.id, { text: '📋 Text sent above ↑' });
      } else {
        await bot.answerCallbackQuery(query.id, {
          text: '⚠️ Draft not available. Greeting may not have been generated.',
          show_alert: true,
        });
      }
    } catch (err) {
      logger.error({ err, leadId }, 'Error in copyText callback');
      try { await bot.answerCallbackQuery(query.id, { text: '❌ Error' }); } catch {}
    }
  };
}

module.exports = { markRespondedHandler, copyTextHandler };
