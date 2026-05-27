'use strict';

const { createLogger }         = require('../../../shared/logger');
const { t }                    = require('../../../shared/i18n');
const { escapeMd }             = require('../../../shared/telegram');
const { sendDailyDigest }      = require('../schedulers/daily');
const { getPreferredLanguage } = require('../../../shared/preferences');
const { langInitKeyboard }     = require('../keyboards');

const logger = createLogger('owner-bot');

module.exports = async function handleYesterday(msg, bot) {
  const chatId = msg.chat.id;
  const lang   = getPreferredLanguage(chatId);

  if (lang === null) {
    try {
      await bot.sendMessage(chatId, t('prefs.choose_initial', 'en'), {
        reply_markup: langInitKeyboard('yesterday'),
      });
    } catch (err) {
      logger.error({ err }, '/yesterday lang picker failed');
    }
    return;
  }

  const langList = lang === 'both' ? ['en', 'ru'] : [lang];
  try {
    await bot.sendMessage(chatId, t('common.loading', langList[0]), { parse_mode: 'MarkdownV2' });
    for (const l of langList) {
      await sendDailyDigest({ withCharts: false, lang: l });
    }
  } catch (err) {
    logger.error({ err }, '/yesterday command failed');
    await bot.sendMessage(
      chatId,
      `❌ Error: \`${escapeMd(err.message)}\``,
      { parse_mode: 'MarkdownV2' }
    );
  }
};
