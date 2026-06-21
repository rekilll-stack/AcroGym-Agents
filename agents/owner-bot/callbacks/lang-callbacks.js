'use strict';

/**
 * callbacks/lang-callbacks.js — language preference callbacks.
 *
 * Handles two callback prefixes:
 *   lang_init:<lang>:<action>  — initial picker (no pref set yet); sets lang then runs action
 *   lang_change:<lang>         — from /lang command; sets lang and shows confirmation only
 *
 * lang:   'en' | 'ru' | 'both'
 * action: 'yesterday' | 'week' | 'month' | 'pending'
 */

const { createLogger }          = require('../../../shared/logger');
const { registerOwnerCallback } = require('../../../shared/telegram');
const { t }                     = require('../../../shared/i18n');
const { setPreferredLanguage }  = require('../../../shared/preferences');
const { sendDailyDigest }       = require('../schedulers/daily');
const { sendWeeklySlice }       = require('../schedulers/weekly');
const { sendMonthlyReport }     = require('../schedulers/monthly');
const { backKeyboard }          = require('../keyboards');

const logger = createLogger('owner-bot');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * MarkdownV2 confirmation text after lang is saved.
 */
function confirmText(lang) {
  if (lang === 'en')   return t('prefs.set_to_en',   'en');
  if (lang === 'ru')   return t('prefs.set_to_ru',   'ru');
  return t('prefs.set_to_both', 'en');
}

/**
 * Which language(s) to build the report in.
 * 'both' → ['en', 'ru'] (two sequential calls)
 */
function langs(lang) {
  return lang === 'both' ? ['en', 'ru'] : [lang];
}

/**
 * Run the original command action after lang has been set.
 */
async function runAction(action, lang, chatId, bot) {
  const langList    = langs(lang);
  const displayLang = langList[0];

  switch (action) {
    case 'yesterday':
      await bot.sendMessage(chatId, t('common.loading', displayLang), { parse_mode: 'MarkdownV2' });
      for (const l of langList) {
        await sendDailyDigest({ withCharts: false, lang: l }).catch(err =>
          logger.error({ err, lang: l }, '[lang-callback] sendDailyDigest failed')
        );
      }
      break;

    case 'week':
      await bot.sendMessage(chatId, t('common.loading', displayLang), { parse_mode: 'MarkdownV2' });
      for (const l of langList) {
        await sendWeeklySlice({ lang: l }).catch(err =>
          logger.error({ err, lang: l }, '[lang-callback] sendWeeklySlice failed')
        );
      }
      break;

    case 'month':
      await bot.sendMessage(chatId, t('common.loading', displayLang), { parse_mode: 'MarkdownV2' });
      for (const l of langList) {
        await sendMonthlyReport({ lang: l }).catch(err =>
          logger.error({ err, lang: l }, '[lang-callback] sendMonthlyReport failed')
        );
      }
      break;

    case 'pending': {
      const handlePending = require('../commands/pending');
      await handlePending({ chat: { id: chatId }, text: '/pending' }, bot);
      break;
    }

    default:
      logger.warn({ action }, '[lang-callback] unknown action after lang selection');
  }
}

// ─────────────────────────────────────────────────────────────
// Main callback handler (shared for both prefixes)
// ─────────────────────────────────────────────────────────────

async function langCallbackHandler(query, bot) {
  const chatId = query.message?.chat?.id;
  const msgId  = query.message?.message_id;
  if (!chatId) return;

  try { await bot.answerCallbackQuery(query.id); } catch {}

  // data format:
  //   lang_init:en:week
  //   lang_change:ru
  const parts  = (query.data || '').split(':');
  const prefix = parts[0];  // 'lang_init' | 'lang_change'
  const lang   = parts[1];  // 'en' | 'ru' | 'both'
  const action = parts[2];  // action for lang_init; undefined for lang_change

  if (!['en', 'ru', 'both'].includes(lang)) {
    logger.warn({ data: query.data }, '[lang-callback] unknown lang value');
    return;
  }

  // Persist the preference
  setPreferredLanguage(chatId, lang);

  // Edit the picker message to show confirmation + back button
  try {
    await bot.editMessageText(confirmText(lang), {
      chat_id:      chatId,
      message_id:   msgId,
      parse_mode:   'MarkdownV2',
      reply_markup: backKeyboard(lang),
    });
  } catch (err) {
    logger.warn({ err: err.message }, '[lang-callback] editMessageText failed');
  }

  // For lang_init: proceed with the original command action
  if (prefix === 'lang_init' && action) {
    await runAction(action, lang, chatId, bot);
  }
  // For lang_change: confirmation is enough — no further action
}

// ─────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────

function setupLangCallbacks() {
  registerOwnerCallback('lang_init',   langCallbackHandler);
  registerOwnerCallback('lang_change', langCallbackHandler);
}

module.exports = { setupLangCallbacks };
