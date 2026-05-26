'use strict';

// ЭТАП 3: menu:* callback routing
// Each menu button sends callback_data = 'menu:<action>'
// The dispatcher in shared/telegram routes by prefix 'menu' → menuCallbackHandler

const { createLogger }       = require('../../../shared/logger');
const { registerOwnerCallback } = require('../../../shared/telegram');
const { sendDailyDigest }    = require('../schedulers/daily');
const { sendWeeklySlice }    = require('../schedulers/weekly');
const { sendMonthlyReport }  = require('../schedulers/monthly');
const { sendMainMenu }       = require('../commands/menu');

const logger = createLogger('owner-bot');

async function menuCallbackHandler(query, bot) {
  const chatId = query.message?.chat?.id;
  if (!chatId) return;

  const [, action] = (query.data || '').split(':');

  // Answer the callback to stop the spinner
  try { await bot.answerCallbackQuery(query.id); } catch {}

  switch (action) {
    case 'daily':
      await bot.sendMessage(chatId, '⏳ Building digest...', { parse_mode: 'HTML' });
      await sendDailyDigest({ withCharts: false }).catch(err =>
        bot.sendMessage(chatId, `❌ ${err.message}`).catch(() => {})
      );
      break;

    case 'weekly':
      await bot.sendMessage(chatId, '⏳ Building weekly slice...', { parse_mode: 'HTML' });
      await sendWeeklySlice({}).catch(err =>
        bot.sendMessage(chatId, `❌ ${err.message}`).catch(() => {})
      );
      break;

    case 'monthly':
      await bot.sendMessage(chatId, '⏳ Building monthly report...', { parse_mode: 'HTML' });
      await sendMonthlyReport({}).catch(err =>
        bot.sendMessage(chatId, `❌ ${err.message}`).catch(() => {})
      );
      break;

    case 'pending': {
      // Simulate /pending command
      const { getAllPending, countPending } = require('../../../shared/db');
      const dayjs = require('dayjs');
      const total = countPending();
      if (total === 0) {
        await bot.sendMessage(chatId, '✅ No pending leads right now.', { parse_mode: 'HTML' });
      } else {
        const leads  = getAllPending(20, 0);
        let text     = `📋 <b>Pending leads (${total})</b>\n\n`;
        const keyboard = [];
        for (let i = 0; i < leads.length; i++) {
          const l = leads[i];
          const h = Math.floor((Date.now() - new Date(l.notified_at).getTime()) / 3600000);
          text += `${i + 1}. ${l.parent_name || '—'} — ${h}h | ${l.parent_phone || '—'}\n`;
          keyboard.push([
            { text: `📋 Copy #${i + 1}`, callback_data: `copy_text:${l.id}` },
            { text: `✅ Done`,            callback_data: `mark_responded:${l.id}` },
          ]);
        }
        await bot.sendMessage(chatId, text, {
          parse_mode:   'HTML',
          reply_markup: { inline_keyboard: keyboard },
        });
      }
      break;
    }

    case 'nurture':
      await bot.sendMessage(chatId, '⏳ Coming with Pre-launch Nurture agent.', { parse_mode: 'HTML' });
      break;

    case 'export':
      await bot.sendMessage(chatId,
        '📤 <b>Export reports</b>\n<i>Coming in ЭТАП 6.</i>',
        { parse_mode: 'HTML' }
      );
      break;

    case 'status': {
      // Delegate to /status handler
      const handleStatus = require('../commands/status');
      await handleStatus({ chat: { id: chatId }, text: '/status' }, bot);
      break;
    }

    case 'help': {
      const handleHelp = require('../commands/help');
      await handleHelp({ chat: { id: chatId }, text: '/help' }, bot);
      break;
    }

    default:
      logger.warn({ action }, 'Unknown menu action');
      await bot.sendMessage(chatId, '❓ Unknown menu action.').catch(() => {});
  }

  // "⬅ Back to menu" after every action (except menu itself)
  if (action && action !== 'help') {
    try {
      await bot.sendMessage(chatId, '─', {
        reply_markup: {
          inline_keyboard: [[{ text: '⬅ Back to menu', callback_data: 'menu:back' }]],
        },
      });
    } catch {}
  }
}

function setupMenuCallbacks() {
  registerOwnerCallback('menu', menuCallbackHandler);
}

module.exports = { setupMenuCallbacks };
