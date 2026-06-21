'use strict';

/**
 * callbacks/menu-callbacks.js — menu:* callback routing.
 * Each menu button sends callback_data = 'menu:<action>'.
 * The dispatcher in shared/telegram routes by prefix 'menu'.
 */

const { createLogger }                    = require('../../../shared/logger');
const { registerOwnerCallback, escapeMd } = require('../../../shared/telegram');
const { t }                               = require('../../../shared/i18n');
const { sendDailyDigest }       = require('../schedulers/daily');
const { sendWeeklySlice }       = require('../schedulers/weekly');
const { sendMonthlyReport }     = require('../schedulers/monthly');
const { openMenu }              = require('../commands/menu');
const { getPreferredLanguage }  = require('../../../shared/preferences');
const { backKeyboard, langInitKeyboard, langChangeKeyboard } = require('../keyboards');

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
      const pendingLang = getPreferredLanguage(chatId) || 'en';
      const total = countPending();
      if (total === 0) {
        await bot.sendMessage(chatId, t('pending.empty', pendingLang), {
          parse_mode:   'MarkdownV2',
          reply_markup: backKeyboard(pendingLang),
        });
      } else {
        const leads    = getAllPending(20, 0);
        let   text     = `${t('pending.title', pendingLang)}\n${t('pending.count_summary', pendingLang, { count: total })}\n\n`;
        const keyboard = [];
        for (let i = 0; i < leads.length; i++) {
          const l = leads[i];
          const h = Math.floor((Date.now() - new Date(l.notified_at).getTime()) / 3600000);
          text += t('pending.lead_line', pendingLang, {
            n:     i + 1,
            name:  escapeMd(l.parent_name  || '—'),
            hours: h,
            phone: escapeMd(l.parent_phone || '—'),
          }) + '\n';
          keyboard.push([
            { text: `📋 Copy #${i + 1}`, callback_data: `copy_text:${l.id}` },
            { text: '✅ Done',            callback_data: `mark_responded:${l.id}` },
          ]);
        }
        keyboard.push([{ text: t('common.back_to_menu', pendingLang), callback_data: 'menu:back' }]);
        await bot.sendMessage(chatId, text, {
          parse_mode:   'MarkdownV2',
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
    case 'back': {
      const backLang = getPreferredLanguage(chatId) || 'en';
      await openMenu(chatId, bot, backLang).catch(err =>
        logger.error({ err }, 'menu:back openMenu failed'));
      break;
    }

    // ── Nurture: read-only execution summary (Owner = eyes) ───
    case 'nurture': {
      const nurture = require('../../../shared/nurture');
      const nurtureLang = getPreferredLanguage(chatId) || 'en';
      try {
        await bot.sendMessage(chatId, nurture.buildOwnerSummaryText(), {
          parse_mode:   'HTML',
          reply_markup: backKeyboard(nurtureLang),
        });
      } catch (err) {
        logger.error({ err }, 'menu:nurture summary failed');
        await bot.sendMessage(chatId, `❌ Nurture summary error: <code>${err.message}</code>`, {
          parse_mode:   'HTML',
          reply_markup: backKeyboard(nurtureLang),
        }).catch(() => {});
      }
      break;
    }

    case 'export': {
      const handleExport = require('../commands/export');
      await handleExport({ chat: { id: chatId }, text: '/export' }, bot);
      break;
    }

    case 'broadcast': {
      const handleBroadcast = require('../commands/broadcast');
      await handleBroadcast({ chat: { id: chatId }, text: '/broadcast' }, bot);
      break;
    }

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
        reply_markup: backKeyboard(getPreferredLanguage(chatId) || 'en'),
      }).catch(() => {});
  }
}

function setupMenuCallbacks() {
  registerOwnerCallback('menu', menuCallbackHandler);
}

module.exports = { setupMenuCallbacks };
