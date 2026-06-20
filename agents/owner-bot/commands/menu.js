'use strict';

// ЭТАП 3: inline main menu (MarkdownV2)
// Callbacks (menu:*) are routed in callbacks/menu-callbacks.js

const { createLogger }         = require('../../../shared/logger');
const { t }                    = require('../../../shared/i18n');
const { getPreferredLanguage } = require('../../../shared/preferences');

const logger = createLogger('owner-bot');

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
  await bot.sendMessage(chatId, text, {
    parse_mode:   'MarkdownV2',
    reply_markup: buildMainKeyboard(lang),
  });
}

module.exports = async function handleMenu(msg, bot) {
  const chatId = msg.chat.id;
  const lang   = getPreferredLanguage(chatId) || 'en';
  try {
    await sendMainMenu(chatId, bot, lang);
  } catch (err) {
    logger.error({ err }, '/menu command failed');
    await bot.sendMessage(chatId, `❌ Error: \`${err.message}\``, { parse_mode: 'MarkdownV2' });
  }
};

module.exports.sendMainMenu      = sendMainMenu;
module.exports.buildMainKeyboard = buildMainKeyboard;
