'use strict';

const { createLogger }    = require('../../../shared/logger');
const { sendDailyDigest } = require('../schedulers/daily');

const logger = createLogger('owner-bot');

module.exports = async function handleYesterday(msg, bot) {
  const chatId = msg.chat.id;
  try {
    await bot.sendMessage(chatId, '⏳ Building yesterday\'s digest...', { parse_mode: 'HTML' });
    await sendDailyDigest({ withCharts: false });
  } catch (err) {
    logger.error({ err }, '/yesterday command failed');
    await bot.sendMessage(chatId, `❌ Error: <code>${err.message}</code>`, { parse_mode: 'HTML' });
  }
};
