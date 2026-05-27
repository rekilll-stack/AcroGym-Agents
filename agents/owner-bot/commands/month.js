'use strict';

const { createLogger }         = require('../../../shared/logger');
const { t }                    = require('../../../shared/i18n');
const { escapeMd }             = require('../../../shared/telegram');
const { sendMonthlyReport }    = require('../schedulers/monthly');
const { getPreferredLanguage } = require('../../../shared/preferences');
const { langInitKeyboard }     = require('../keyboards');

const logger = createLogger('owner-bot');

module.exports = async function handleMonth(msg, bot) {
  const chatId = msg.chat.id;
  const lang   = getPreferredLanguage(chatId);

  if (lang === null) {
    try {
      await bot.sendMessage(chatId, t('prefs.choose_initial', 'en'), {
        reply_markup: langInitKeyboard('month'),
      });
    } catch (err) {
      logger.error({ err }, '/month lang picker failed');
    }
    return;
  }

  const langList = lang === 'both' ? ['en', 'ru'] : [lang];
  try {
    await bot.sendMessage(chatId, t('common.loading', langList[0]), { parse_mode: 'MarkdownV2' });
    for (const l of langList) {
      await sendMonthlyReport({ lang: l });
    }
  } catch (err) {
    logger.error({ err }, '/month command failed');
    await bot.sendMessage(
      chatId,
      `❌ Error: \`${escapeMd(err.message)}\``,
      { parse_mode: 'MarkdownV2' }
    );
  }
};
