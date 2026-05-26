'use strict';

// TODO ЭТАП 5: full monthly report command

const { createLogger }        = require('../../../shared/logger');
const { sendMonthlyReport }   = require('../schedulers/monthly');

const logger = createLogger('owner-bot');

module.exports = async function handleMonth(msg, bot) {
  const chatId = msg.chat.id;
  try {
    await bot.sendMessage(chatId, '⏳ Building monthly report...', { parse_mode: 'HTML' });
    await sendMonthlyReport({});
  } catch (err) {
    logger.error({ err }, '/month command failed');
    await bot.sendMessage(chatId, `❌ Error: <code>${err.message}</code>`, { parse_mode: 'HTML' });
  }
};
