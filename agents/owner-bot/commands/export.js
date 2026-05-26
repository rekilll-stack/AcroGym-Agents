'use strict';

// TODO ЭТАП 6: full export flow (period → language → format → generate → send)
// State machine via SQLite user_state table

const { createLogger } = require('../../../shared/logger');
const logger = createLogger('owner-bot');

module.exports = async function handleExport(msg, bot) {
  const chatId = msg.chat.id;
  try {
    await bot.sendMessage(chatId,
      '📤 <b>Export reports</b>\n<i>Full export with PDF/PPTX coming in ЭТАП 6.</i>',
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    logger.error({ err }, '/export command failed');
  }
};
