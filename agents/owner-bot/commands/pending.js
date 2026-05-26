'use strict';

const dayjs = require('dayjs');
const utc   = require('dayjs/plugin/utc');
const tz    = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

const { createLogger }              = require('../../../shared/logger');
const { getAllPending, countPending } = require('../../../shared/db');

const logger   = createLogger('owner-bot');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Qatar';
const PAGE     = 20;

module.exports = async function handlePending(msg, bot) {
  const chatId = msg.chat.id;
  const parts  = (msg.text || '').trim().split(/\s+/);
  const offset = Math.max(0, (parseInt(parts[1], 10) || 1) - 1);

  try {
    const total = countPending();
    if (total === 0) {
      await bot.sendMessage(chatId, '✅ No pending leads right now.', { parse_mode: 'HTML' });
      return;
    }

    const leads = getAllPending(PAGE, offset);
    const now   = dayjs().tz(TIMEZONE);
    const from  = offset + 1;
    const to    = offset + leads.length;

    let text     = `📋 <b>Pending leads ${from}–${to} of ${total}</b>\n\n`;
    const keyboard = [];

    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];
      const h    = now.diff(dayjs(lead.notified_at), 'hour');
      text += `${from + i}. ${lead.parent_name || '—'} — ${h}h | ${lead.parent_phone || '—'}\n`;
      if (i % 2 === 0) {
        keyboard.push([{ text: `📋 Copy #${from + i}`, callback_data: `copy_text:${lead.id}` }]);
      } else {
        keyboard[keyboard.length - 1].push(
          { text: `📋 Copy #${from + i}`, callback_data: `copy_text:${lead.id}` }
        );
      }
    }

    if (to < total) {
      text += `\n<i>Showing ${from}–${to} of ${total}. Use /pending ${to + 1} to see more.</i>`;
    }

    await bot.sendMessage(chatId, text, {
      parse_mode:   'HTML',
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (err) {
    logger.error({ err }, '/pending command failed');
    await bot.sendMessage(chatId, `❌ Error: <code>${err.message}</code>`, { parse_mode: 'HTML' });
  }
};
