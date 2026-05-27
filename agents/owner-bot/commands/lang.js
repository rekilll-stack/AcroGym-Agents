'use strict';

/**
 * commands/lang.js — /lang command: change language preference.
 *
 * Shows an inline keyboard. The selected button triggers lang_change:<lang>
 * callback which persists the preference and sends confirmation.
 */

const { createLogger }      = require('../../../shared/logger');
const { t }                 = require('../../../shared/i18n');
const { langChangeKeyboard } = require('../keyboards');

const logger = createLogger('owner-bot');

module.exports = async function handleLang(msg, bot) {
  const chatId = msg.chat.id;

  try {
    await bot.sendMessage(chatId, t('prefs.choose_change', 'en'), {
      reply_markup: langChangeKeyboard(),
    });
  } catch (err) {
    logger.error({ err }, '/lang command failed');
  }
};
