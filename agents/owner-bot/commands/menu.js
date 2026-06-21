'use strict';

// ЭТАП 3: inline main menu (MarkdownV2)
// Callbacks (menu:*) are routed in callbacks/menu-callbacks.js

const { createLogger }         = require('../../../shared/logger');
const { t }                    = require('../../../shared/i18n');
const { getPreferredLanguage } = require('../../../shared/preferences');
const { persistentMenuKeyboard } = require('../keyboards');

const logger = createLogger('owner-bot');

// In-memory, per chat. openConsole: message_id of the currently-shown console
// (so the persistent button can hide it by deleting). kbLang: the language the
// persistent bottom button was last set for (re-set on language change). Lost on
// restart — harmless: the first tap afterwards just opens a fresh console.
const openConsole = new Map();
const kbLang      = new Map();

/** Establish (or refresh on language change) the persistent bottom button. */
async function ensurePersistentButton(chatId, bot, lang) {
  if (kbLang.get(chatId) === lang) return;
  await bot.sendMessage(chatId, t('menu.subtitle', lang), {
    parse_mode:   'MarkdownV2',
    reply_markup: persistentMenuKeyboard(lang),
  }).catch(() => {});
  kbLang.set(chatId, lang);
}

function buildMainKeyboard(lang = 'en') {
  return {
    inline_keyboard: [
      [{ text: t('menu.btn_daily',       lang), callback_data: 'menu:daily'   }],
      [
        { text: t('menu.btn_weekly',  lang), callback_data: 'menu:weekly'  },
        { text: t('menu.btn_monthly', lang), callback_data: 'menu:monthly' },
      ],
      [
        { text: t('menu.btn_pending',      lang), callback_data: 'menu:pending' },
        { text: t('menu.btn_nurture', lang), callback_data: 'menu:nurture' },
      ],
      [{ text: t('menu.btn_export', lang), callback_data: 'menu:export' }],
      [{ text: t('broadcast.btn_menu', lang), callback_data: 'menu:broadcast' }],
      [
        { text: t('menu.btn_status', lang), callback_data: 'menu:status' },
        { text: t('menu.btn_lang',   lang), callback_data: 'menu:lang'   },
        { text: t('menu.btn_help',   lang), callback_data: 'menu:help'   },
      ],
    ],
  };
}

/**
 * Send the main menu message (MarkdownV2).
 * Called from /menu command and from "⬅ Back to menu" callbacks.
 */
async function sendMainMenu(chatId, bot, lang = 'en') {
  // title has *bold* and subtitle has _italic_ — both correct MDv2
  const text = `${t('menu.title', lang)}\n${t('menu.subtitle', lang)}`;
  return bot.sendMessage(chatId, text, {
    parse_mode:   'MarkdownV2',
    reply_markup: buildMainKeyboard(lang),
  });
}

/**
 * Open (or re-open) the inline console, tracking its message so the persistent
 * button can hide it later. Deletes a previously-tracked console first so only
 * one is ever open. Also ensures the persistent bottom button is present.
 */
async function openMenu(chatId, bot, lang = 'en') {
  await ensurePersistentButton(chatId, bot, lang);
  const oldId = openConsole.get(chatId);
  if (oldId) { await bot.deleteMessage(chatId, oldId).catch(() => {}); openConsole.delete(chatId); }
  const sent = await sendMainMenu(chatId, bot, lang);
  if (sent && sent.message_id) openConsole.set(chatId, sent.message_id);
  return sent;
}

/** Persistent-button tap: open the console if hidden, hide (delete) it if shown. */
async function toggleMenu(msg, bot) {
  const chatId = msg.chat.id;
  const lang   = getPreferredLanguage(chatId) || 'en';
  const openId = openConsole.get(chatId);
  if (openId) {
    await bot.deleteMessage(chatId, openId).catch(() => {}); // hide
    openConsole.delete(chatId);
  } else {
    await openMenu(chatId, bot, lang); // show
  }
}

module.exports = async function handleMenu(msg, bot) {
  const chatId = msg.chat.id;
  const lang   = getPreferredLanguage(chatId) || 'en';
  try {
    await openMenu(chatId, bot, lang);
  } catch (err) {
    logger.error({ err }, '/menu command failed');
    await bot.sendMessage(chatId, `❌ Error: \`${err.message}\``, { parse_mode: 'MarkdownV2' });
  }
};

module.exports.sendMainMenu      = sendMainMenu;
module.exports.buildMainKeyboard = buildMainKeyboard;
module.exports.openMenu          = openMenu;
module.exports.toggleMenu        = toggleMenu;
