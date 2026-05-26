'use strict';

// NOTE: This is the current lightweight /week command.
// ЭТАП 4 will replace the body with a call to weekly-builder.js,
// which uses month_names / day_names from shared/i18n (NOT _months / _days_long).

const dayjs = require('dayjs');
const utc   = require('dayjs/plugin/utc');
const tz    = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

const { createLogger }   = require('../../../shared/logger');
const {
  countLeadsInRange,
  getLongPending,
  getLeadsByDay,
  getLeadsByDayRange,
} = require('../../../shared/db');
const { buildDayOfWeek } = require('../builders/daily-builder');

const logger   = createLogger('owner-bot');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Qatar';

module.exports = async function handleWeek(msg, bot) {
  const chatId = msg.chat.id;
  try {
    await bot.sendMessage(chatId, '⏳ Building weekly report...', { parse_mode: 'HTML' });

    const now       = dayjs().tz(TIMEZONE);
    const thisStart = now.subtract(7,  'day').format('YYYY-MM-DD');
    const thisEnd   = now.subtract(1,  'day').format('YYYY-MM-DD');
    const prevStart = now.subtract(14, 'day').format('YYYY-MM-DD');
    const prevEnd   = now.subtract(8,  'day').format('YYYY-MM-DD');

    const thisWeek  = countLeadsInRange(thisStart, thisEnd);
    const prevWeek  = countLeadsInRange(prevStart, prevEnd);
    const longPnd   = getLongPending(24);
    const dayOfWeek = buildDayOfWeek(7);

    let text = `📅 <b>Weekly Report</b>\n`;
    text    += `<i>${thisStart} → ${thisEnd}</i>\n\n`;
    text    += `📊 <b>This week:</b> ${thisWeek} leads\n`;
    text    += `📊 <b>Previous week:</b> ${prevWeek} leads\n`;

    if (prevWeek > 0) {
      const change = Math.round((thisWeek - prevWeek) / prevWeek * 100);
      const arrow  = change >= 0 ? '↗️' : '↘️';
      text += `📈 <b>Trend:</b> ${arrow} ${change >= 0 ? '+' : ''}${change}%\n`;
    }

    const bestDay  = Object.entries(dayOfWeek).sort((a, b) => b[1] - a[1])[0];
    const worstDay = Object.entries(dayOfWeek).filter(([,v]) => v > 0).sort((a, b) => a[1] - b[1])[0];
    if (bestDay && bestDay[1] > 0) text += `\n🏆 Best day: ${bestDay[0]} (${bestDay[1]})\n`;
    if (worstDay && worstDay[0] !== bestDay?.[0]) text += `📉 Slowest: ${worstDay[0]} (${worstDay[1]})\n`;

    if (longPnd.length > 0) {
      text += `\n🚨 <b>Long pending (&gt;24h):</b> ${longPnd.length} lead(s)\n`;
      longPnd.forEach(l => {
        const h = Math.floor((Date.now() - new Date(l.notified_at).getTime()) / 3600000);
        text += `• ${l.parent_name || '—'} — ${h}h\n`;
      });
    }

    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });

    // Comparison chart
    const thisData = getLeadsByDay(7);
    const prevData = getLeadsByDayRange(prevStart, prevEnd);
    const labels   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const thisMap  = Object.fromEntries(thisData.map(r => [dayjs(r.day).format('ddd'), r.cnt]));
    const prevMap  = Object.fromEntries(prevData.map(r => [dayjs(r.day).format('ddd'), r.cnt]));

    try {
      const { renderWeeklyComparison } = require('../../../shared/chart');
      const chartBuf = await renderWeeklyComparison({
        title:         'This week vs previous week',
        labels,
        current_week:  labels.map(d => thisMap[d] || 0),
        previous_week: labels.map(d => prevMap[d] || 0),
      });
      await bot.sendPhoto(chatId, chartBuf, { caption: '📊 Weekly comparison chart' });
    } catch (chartErr) {
      logger.warn({ err: chartErr.message }, '/week chart rendering failed');
    }

  } catch (err) {
    logger.error({ err }, '/week command failed');
    await bot.sendMessage(chatId, `❌ Error: <code>${err.message}</code>`, { parse_mode: 'HTML' });
  }
};
