'use strict';

const { createLogger }          = require('../../../shared/logger');
const { t }                     = require('../../../shared/i18n');
const { escapeMd }              = require('../../../shared/telegram');
const { sendWeeklySlice }       = require('../schedulers/weekly');
const { getPreferredLanguage }  = require('../../../shared/preferences');
const { langInitKeyboard }      = require('../keyboards');

const logger = createLogger('owner-bot');

module.exports = async function handleWeek(msg, bot) {
  const chatId = msg.chat.id;
  const lang   = getPreferredLanguage(chatId);

  // No preference set yet — show language picker
  if (lang === null) {
    try {
      await bot.sendMessage(chatId, t('prefs.choose_initial', 'en'), {
        reply_markup: langInitKeyboard('week'),
      });
    } catch (err) {
      logger.error({ err }, '/week lang picker failed');
    }
    return;
  }

  // Preference known — build and send
  const langList = lang === 'both' ? ['en', 'ru'] : [lang];
  try {
    await bot.sendMessage(chatId, t('common.loading', langList[0]), { parse_mode: 'MarkdownV2' });
    for (const l of langList) {
      await sendWeeklySlice({ lang: l });
    }
  } catch (err) {
    logger.error({ err }, '/week command failed');
    await bot.sendMessage(
      chatId,
      `❌ Error: \`${escapeMd(err.message)}\``,
      { parse_mode: 'MarkdownV2' }
    );
  }
};
