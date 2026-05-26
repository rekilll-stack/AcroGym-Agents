'use strict';

// TODO ЭТАП 6: export:* callback routing (period → language → format → generate)

const { createLogger }        = require('../../../shared/logger');
const { registerOwnerCallback } = require('../../../shared/telegram');

const logger = createLogger('owner-bot');

async function exportCallbackHandler(query, bot) {
  const chatId = query.message?.chat?.id;
  if (!chatId) return;
  try { await bot.answerCallbackQuery(query.id); } catch {}
  // TODO ЭТАП 6: parse export:period:lang:format steps
  await bot.sendMessage(chatId,
    '📤 <b>Export</b>\n<i>Full flow coming in ЭТАП 6.</i>',
    { parse_mode: 'HTML' }
  ).catch(() => {});
}

function setupExportCallbacks() {
  registerOwnerCallback('export', exportCallbackHandler);
}

module.exports = { setupExportCallbacks };
