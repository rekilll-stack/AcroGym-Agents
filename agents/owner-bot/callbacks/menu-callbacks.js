'use strict';

/**
 * callbacks/menu-callbacks.js — menu:* callback routing.
 * Each menu button sends callback_data = 'menu:<action>'.
 * The dispatcher in shared/telegram routes by prefix 'menu'.
 */

const { createLogger }          = require('../../../shared/logger');
const { registerOwnerCallback } = require('../../../shared/telegram');
const { t }                     = require('../../../shared/i18n');
const { sendDailyDigest }       = require('../schedulers/daily');
const { sendWeeklySlice }       = require('../schedulers/weekly');
const { sendMonthlyReport }     = require('../schedulers/monthly');
const { sendMainMenu }          = require('../commands/menu');
const { getPreferredLanguage }  = require('../../../shared/preferences');
const { BACK_KB, langInitKeyboard, langChangeKeyboard } = require('../keyboards');

const logger = createLogger('owner-bot');

async function menuCallbackHandler(query, bot) {
  const chatId = query.message?.chat?.id;
  if (!chatId) return;

  const [, action] = (query.data || '').split(':');

  // Answer the callback to stop the spinner
  try { await bot.answerCallbackQuery(query.id); } catch {}

  const prefLang = getPreferredLanguage(chatId);
  const langList = (l) => l === 'both' ? ['en', 'ru'] : [l];

  switch (action) {

    // ── Report actions — check preference ────────────────────
    case 'daily':
      if (prefLang === null) {
        await bot.sendMessage(chatId, t('prefs.choose_initial', 'en'),
          { reply_markup: langInitKeyboard('yesterday') });
        break;
      }
      await bot.sendMessage(chatId,
        t('common.loading', prefLang === 'both' ? 'en' : prefLang),
        { parse_mode: 'MarkdownV2' });
      for (const l of langList(prefLang)) {
        await sendDailyDigest({ withCharts: false, lang: l }).catch(err =>
          bot.sendMessage(chatId, `❌ ${err.message}`).catch(() => {}));
      }
      break;

    case 'weekly':
      if (prefLang === null) {
        await bot.sendMessage(chatId, t('prefs.choose_initial', 'en'),
          { reply_markup: langInitKeyboard('week') });
        break;
      }
      await bot.sendMessage(chatId,
        t('common.loading', prefLang === 'both' ? 'en' : prefLang),
        { parse_mode: 'MarkdownV2' });
      for (const l of langList(prefLang)) {
        await sendWeeklySlice({ lang: l }).catch(err =>
          bot.sendMessage(chatId, `❌ ${err.message}`).catch(() => {}));
      }
      break;

    case 'monthly':
      if (prefLang === null) {
        await bot.sendMessage(chatId, t('prefs.choose_initial', 'en'),
          { reply_markup: langInitKeyboard('month') });
        break;
      }
      await bot.sendMessage(chatId,
        t('common.loading', prefLang === 'both' ? 'en' : prefLang),
        { parse_mode: 'MarkdownV2' });
      for (const l of langList(prefLang)) {
        await sendMonthlyReport({ lang: l }).catch(err =>
          bot.sendMessage(chatId, `❌ ${err.message}`).catch(() => {}));
      }
      break;

    // ── Pending ───────────────────────────────────────────────
    case 'pending': {
      const { getAllPending, countPending } = require('../../../shared/db');
      const total = countPending();
      if (total === 0) {
        await bot.sendMessage(chatId, '✅ No pending leads right now\\.', {
          parse_mode:   'MarkdownV2',
          reply_markup: BACK_KB,
        });
      } else {
        const leads    = getAllPending(20, 0);
        let   text     = `📋 <b>Pending leads (${total})</b>\n\n`;
        const keyboard = [];
        for (let i = 0; i < leads.length; i++) {
          const l = leads[i];
          const h = Math.floor((Date.now() - new Date(l.notified_at).getTime()) / 3600000);
          text += `${i + 1}. ${l.parent_name || '—'} — ${h}h | ${l.parent_phone || '—'}\n`;
          keyboard.push([
            { text: `📋 Copy #${i + 1}`, callback_data: `copy_text:${l.id}` },
            { text: '✅ Done',            callback_data: `mark_responded:${l.id}` },
          ]);
        }
        keyboard.push([{ text: t('common.back_to_menu', 'en'), callback_data: 'menu:back' }]);
        await bot.sendMessage(chatId, text, {
          parse_mode:   'HTML',
          reply_markup: { inline_keyboard: keyboard },
        });
      }
      break;
    }

    // ── Language picker ───────────────────────────────────────
    case 'lang':
      await bot.sendMessage(chatId, t('prefs.choose_change', 'en'), {
        reply_markup: langChangeKeyboard(),
      });
      break;

    // ── Back to menu ──────────────────────────────────────────
    case 'back':
      await sendMainMenu(chatId, bot, 'en').catch(err =>
        logger.error({ err }, 'menu:back sendMainMenu failed'));
      break;

    // ── Other ─────────────────────────────────────────────────
    case 'nurture':
      await bot.sendMessage(chatId, '⏳ Coming with Pre\\-launch Nurture agent\\.', {
        parse_mode:   'MarkdownV2',
        reply_markup: BACK_KB,
      });
      break;

    case 'export':
      await bot.sendMessage(chatId,
        '📤 *Export reports*\n_Coming in ЭТАП 6\\._',
        { parse_mode: 'MarkdownV2', reply_markup: BACK_KB }
      );
      break;

    case 'status': {
      const handleStatus = require('../commands/status');
      await handleStatus({ chat: { id: chatId }, text: '/status' }, bot);
      break;
    }

    case 'help': {
      const handleHelp = require('../commands/help');
      await handleHelp({ chat: { id: chatId }, text: '/help' }, bot);
      break;
    }

    default:
      logger.warn({ action }, 'Unknown menu action');
      await bot.sendMessage(chatId, '❓ Unknown menu action\\.', {
        parse_mode:   'MarkdownV2',
        reply_markup: BACK_KB,
      }).catch(() => {});
  }
}

function setupMenuCallbacks() {
  registerOwnerCallback('menu', menuCallbackHandler);
}

module.exports = { setupMenuCallbacks };
