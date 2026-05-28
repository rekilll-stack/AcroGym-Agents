'use strict';

/**
 * keyboards/calendar.js — Telegram inline calendar keyboard builder.
 *
 * Generates a month-grid keyboard for date picking.
 * Navigation edits the message in-place (editMessageReplyMarkup).
 * Future dates are shown as · and disabled.
 * Allows navigating back up to MAX_MONTHS_BACK from today.
 *
 * Callback data format:
 *   cal:ignore           — empty cell / header (silently ignored)
 *   cal:nav:YYYY-MM      — navigate to another month
 *   cal:pick:YYYY-MM-DD  — user selected this date
 */

const dayjs = require('dayjs');
const utc   = require('dayjs/plugin/utc');
const tz    = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

const TIMEZONE = process.env.TIMEZONE || 'Asia/Qatar';

const MAX_MONTHS_BACK = 6;

const MONTH_NAMES = {
  en: ['January','February','March','April','May','June',
       'July','August','September','October','November','December'],
  ru: ['Январь','Февраль','Март','Апрель','Май','Июнь',
       'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'],
};

const DOW_LABELS = {
  en: ['Mo','Tu','We','Th','Fr','Sa','Su'],
  ru: ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'],
};

/**
 * Build an inline calendar keyboard.
 *
 * @param {number} year   — 4-digit year
 * @param {number} month  — 1–12
 * @param {string} lang   — 'en' | 'ru'
 * @param {object} opts
 * @param {string} opts.today       — YYYY-MM-DD (required; dates after this are disabled)
 * @param {string} [opts.cancelCb]  — cancel button callback_data (default: 'export:cancel')
 * @returns {{ inline_keyboard: Array }}
 */
function buildCalendarKeyboard(year, month, lang, { today, cancelCb = 'export:cancel' } = {}) {
  const l      = (lang === 'ru') ? 'ru' : 'en';
  const mNames = MONTH_NAMES[l];
  const dows   = DOW_LABELS[l];

  const thisYM = `${year}-${String(month).padStart(2, '0')}`;

  // Earliest navigable month
  const minDay = dayjs(today).subtract(MAX_MONTHS_BACK, 'month');
  const minYM  = `${minDay.year()}-${String(minDay.month() + 1).padStart(2, '0')}`;

  // Today's year-month (can't go past current month into future)
  const todayYM = today.slice(0, 7);

  // Previous / next month strings
  const prevD  = dayjs(`${thisYM}-01`).subtract(1, 'month');
  const nextD  = dayjs(`${thisYM}-01`).add(1, 'month');
  const prevYM = `${prevD.year()}-${String(prevD.month() + 1).padStart(2, '0')}`;
  const nextYM = `${nextD.year()}-${String(nextD.month() + 1).padStart(2, '0')}`;

  const canPrev = thisYM > minYM;
  const canNext = thisYM < todayYM;

  const rows = [];

  // ── Navigation row ──────────────────────────────────────────
  rows.push([
    canPrev
      ? { text: '◀️', callback_data: `cal:nav:${prevYM}` }
      : { text: '  ',  callback_data: 'cal:ignore' },
    { text: `${mNames[month - 1]} ${year}`, callback_data: 'cal:ignore' },
    canNext
      ? { text: '▶️', callback_data: `cal:nav:${nextYM}` }
      : { text: '  ',  callback_data: 'cal:ignore' },
  ]);

  // ── Day-of-week header ──────────────────────────────────────
  rows.push(dows.map(d => ({ text: d, callback_data: 'cal:ignore' })));

  // ── Day grid (Mon-first) ────────────────────────────────────
  // dayjs .day() returns 0=Sun … 6=Sat; convert to 0=Mon … 6=Sun
  const firstDow    = dayjs(`${thisYM}-01`).day();
  const offsetMon   = firstDow === 0 ? 6 : firstDow - 1;
  const daysInMonth = dayjs(`${thisYM}-01`).daysInMonth();

  let week = [];
  for (let i = 0; i < offsetMon; i++) {
    week.push({ text: ' ', callback_data: 'cal:ignore' });
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr  = `${thisYM}-${String(day).padStart(2, '0')}`;
    const isFuture = dateStr > today;

    week.push(
      isFuture
        ? { text: '·', callback_data: 'cal:ignore' }
        : { text: String(day), callback_data: `cal:pick:${dateStr}` }
    );

    if (week.length === 7) { rows.push(week); week = []; }
  }

  // Pad last partial week
  if (week.length > 0) {
    while (week.length < 7) week.push({ text: ' ', callback_data: 'cal:ignore' });
    rows.push(week);
  }

  // ── Cancel / Menu row ───────────────────────────────────────
  const cancelLabel = l === 'ru' ? '❌ Отмена' : '❌ Cancel';
  const menuLabel   = l === 'ru' ? '⬅ Меню'   : '⬅ Menu';
  rows.push([
    { text: cancelLabel, callback_data: cancelCb  },
    { text: menuLabel,   callback_data: 'menu:back' },
  ]);

  return { inline_keyboard: rows };
}

/**
 * Returns { year, month } for the current month in TIMEZONE.
 */
function currentYearMonth() {
  const now = dayjs().tz(TIMEZONE);
  return { year: now.year(), month: now.month() + 1 };
}

/**
 * Returns today's date string in TIMEZONE.
 */
function todayString() {
  return dayjs().tz(TIMEZONE).format('YYYY-MM-DD');
}

/**
 * Returns { dateFrom, dateTo } for the Mon–Sun week containing dateStr.
 */
function getWeekForDate(dateStr) {
  const d   = dayjs(dateStr);
  const dow = d.day(); // 0=Sun
  const daysFromMon = dow === 0 ? 6 : dow - 1;
  const mon = d.subtract(daysFromMon, 'day');
  const sun = mon.add(6, 'day');
  return { dateFrom: mon.format('YYYY-MM-DD'), dateTo: sun.format('YYYY-MM-DD') };
}

/**
 * Returns { dateFrom, dateTo } for the calendar month containing dateStr.
 */
function getMonthForDate(dateStr) {
  const d = dayjs(dateStr);
  return {
    dateFrom: d.startOf('month').format('YYYY-MM-DD'),
    dateTo:   d.endOf('month').format('YYYY-MM-DD'),
  };
}

module.exports = {
  buildCalendarKeyboard,
  currentYearMonth,
  todayString,
  getWeekForDate,
  getMonthForDate,
};
