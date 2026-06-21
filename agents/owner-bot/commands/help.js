'use strict';

const { createLogger }         = require('../../../shared/logger');
const { t }                    = require('../../../shared/i18n');
const { escapeMd }             = require('../../../shared/telegram');
const { backKeyboard }         = require('../keyboards');
const { getPreferredLanguage } = require('../../../shared/preferences');

const logger = createLogger('owner-bot');

module.exports = async function handleHelp(msg, bot) {
  const chatId = msg.chat.id;
  const lang   = getPreferredLanguage(chatId) || 'en';

  // Strings with intentional *bold* / _italic_ → use directly (pre-escaped MDv2).
  // Strings that are plain text with potential special chars → wrap in escapeMd().
  const lines = [
    t('help.title', lang),                      // ❓ *AcroGym Owner Bot — Help*
    '',
    escapeMd(t('help.intro', lang)),             // plain text, might have . etc.
    '',
    t('help.cmd_menu',      lang),               // /menu — open main console
    t('help.cmd_yesterday', lang),               // /yesterday — yesterday's digest
    t('help.cmd_week',      lang),               // /week — weekly slice
    t('help.cmd_month',     lang),               // /month — monthly report
    t('help.cmd_pending',   lang),               // /pending — list of pending leads
    t('help.cmd_export',    lang),               // /export — export reports \(PDF/PPTX\)
    t('help.cmd_lang',      lang),               // /lang — change language preference
    t('help.cmd_status',    lang),               // /status — system health check
    t('help.cmd_help',      lang),               // /help — this message
    '',
    `_${escapeMd(t('help.footer', lang))}_`,     // italic plain footer
  ];

  try {
    await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'MarkdownV2', reply_markup: backKeyboard(lang) });
  } catch (err) {
    logger.error({ err }, '/help command failed');
  }
};
