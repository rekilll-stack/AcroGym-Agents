'use strict';

/**
 * callbacks/export-callbacks.js — /export multi-step flow.
 *
 * State machine: period → [week/month/date input] → lang → format → generate
 *
 * Registered callback prefixes: 'export', 'month'
 * Text handler: registered via registerOwnerTextHandler for date input steps.
 */

const path  = require('path');
const fs    = require('fs');
const dayjs = require('dayjs');
const utc   = require('dayjs/plugin/utc');
const tz    = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

const { createLogger }          = require('../../../shared/logger');
const { t }                     = require('../../../shared/i18n');
const {
  registerOwnerCallback,
  registerOwnerTextHandler,
  sendDocumentToOwner,
  escapeMd,
} = require('../../../shared/telegram');
const {
  setState, getState, updateParams, setStep, clearState, isExpired,
} = require('../../../shared/state');
const { getPreferredLanguage } = require('../../../shared/preferences');
const { generatePdf }          = require('../exporters/pdf-exporter');
const { generatePptx }         = require('../exporters/pptx-exporter');
const {
  buildCalendarKeyboard,
  currentYearMonth,
  todayString,
  getWeekForDate,
  getMonthForDate,
} = require('../keyboards/calendar');

const logger   = createLogger('owner-bot');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Qatar';
const EXPORTS_DIR = path.join(__dirname, '../../../exports');

// ─────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────

function thisMonthRange() {
  const now = dayjs().tz(TIMEZONE);
  return { dateFrom: now.startOf('month').format('YYYY-MM-DD'), dateTo: now.format('YYYY-MM-DD') };
}
function lastMonthRange() {
  const last = dayjs().tz(TIMEZONE).subtract(1, 'month');
  return { dateFrom: last.startOf('month').format('YYYY-MM-DD'), dateTo: last.endOf('month').format('YYYY-MM-DD') };
}
function twoMonthsAgoRange() {
  const ref = dayjs().tz(TIMEZONE).subtract(2, 'month');
  return { dateFrom: ref.startOf('month').format('YYYY-MM-DD'), dateTo: ref.endOf('month').format('YYYY-MM-DD') };
}
function thisWeekRange() {
  const now = dayjs().tz(TIMEZONE);
  const dow = now.day();
  const daysFromMon = dow === 0 ? 6 : dow - 1;
  return { dateFrom: now.subtract(daysFromMon, 'day').format('YYYY-MM-DD'), dateTo: now.format('YYYY-MM-DD') };
}
function lastWeekRange() {
  const now = dayjs().tz(TIMEZONE);
  const dow = now.day();
  const daysFromMon = dow === 0 ? 6 : dow - 1;
  const thisMon = now.subtract(daysFromMon, 'day');
  return { dateFrom: thisMon.subtract(7, 'day').format('YYYY-MM-DD'), dateTo: thisMon.subtract(1, 'day').format('YYYY-MM-DD') };
}
function twoWeeksAgoRange() {
  const now = dayjs().tz(TIMEZONE);
  const dow = now.day();
  const daysFromMon = dow === 0 ? 6 : dow - 1;
  const thisMon = now.subtract(daysFromMon, 'day');
  return { dateFrom: thisMon.subtract(14, 'day').format('YYYY-MM-DD'), dateTo: thisMon.subtract(8, 'day').format('YYYY-MM-DD') };
}
function dayRange(daysBack) {
  const d = dayjs().tz(TIMEZONE).subtract(daysBack, 'day').format('YYYY-MM-DD');
  return { dateFrom: d, dateTo: d };
}

// ─────────────────────────────────────────────────────────────
// Keyboard builders
// ─────────────────────────────────────────────────────────────

function backCancelRow(lang) {
  return [
    { text: `❌ ${t('common.cancel', lang)}`, callback_data: 'export:cancel' },
    { text: t('common.back_to_menu', lang),   callback_data: 'menu:back'     },
  ];
}

function dayChoiceKeyboard(lang) {
  return {
    inline_keyboard: [
      [
        { text: t('export.btn_day_yesterday', lang), callback_data: 'export:day:yesterday'  },
        { text: t('export.btn_day_2days',     lang), callback_data: 'export:day:2_days_ago' },
      ],
      [{ text: t('export.btn_day_3days', lang),      callback_data: 'export:day:3_days_ago' }],
      backCancelRow(lang),
    ],
  };
}

function weekChoiceKeyboard(lang) {
  return {
    inline_keyboard: [
      [
        { text: t('export.btn_week_last', lang), callback_data: 'export:week:last_week'   },
        { text: t('export.btn_week_this', lang), callback_data: 'export:week:this_week'   },
      ],
      [{ text: t('export.btn_week_2ago', lang),  callback_data: 'export:week:2_weeks_ago' }],
      backCancelRow(lang),
    ],
  };
}

function monthChoiceKeyboard(lang) {
  return {
    inline_keyboard: [
      [
        { text: t('export.btn_month_last', lang), callback_data: 'export:month_choice:last_month'   },
        { text: t('export.btn_month_this', lang), callback_data: 'export:month_choice:this_month'   },
      ],
      [{ text: t('export.btn_month_2ago', lang),  callback_data: 'export:month_choice:2_months_ago' }],
      backCancelRow(lang),
    ],
  };
}

function langKeyboard(lang, defaultLang) {
  const defaultEmoji = defaultLang === 'en' ? '🇬🇧' : defaultLang === 'ru' ? '🇷🇺' : '🌐';
  const defaultName  = defaultLang === 'en' ? 'English' : defaultLang === 'ru' ? 'Русский' : 'Both';
  const defaultHint  = defaultLang ? `\n_Default: ${defaultEmoji} ${defaultName}_` : '';
  return {
    inline_keyboard: [
      [
        { text: t('export.btn_lang_en',   lang), callback_data: 'export:lang:en'   },
        { text: t('export.btn_lang_ru',   lang), callback_data: 'export:lang:ru'   },
        { text: t('export.btn_lang_both', lang), callback_data: 'export:lang:both' },
      ],
      backCancelRow(lang),
    ],
  };
}

function formatKeyboard(lang) {
  return {
    inline_keyboard: [
      [{ text: t('export.btn_format_pdf',  lang), callback_data: 'export:format:pdf'  }],
      [{ text: t('export.btn_format_pptx', lang), callback_data: 'export:format:pptx' }],
      [{ text: t('export.btn_format_both', lang), callback_data: 'export:format:both' }],
      backCancelRow(lang),
    ],
  };
}

function backMenuKeyboard(lang) {
  return { inline_keyboard: [[{ text: t('common.back_to_menu', lang), callback_data: 'menu:back' }]] };
}

// ─────────────────────────────────────────────────────────────
// Timeout check helper
// ─────────────────────────────────────────────────────────────

async function checkTimeout(state, chatId, bot, lang) {
  if (!isExpired(state)) return false;
  clearState(chatId);
  await bot.sendMessage(chatId, t('export.timeout', lang), {
    parse_mode:   'MarkdownV2',
    reply_markup: backMenuKeyboard(lang),
  }).catch(() => {});
  return true;
}

// ─────────────────────────────────────────────────────────────
// Show lang selection (step 2/3)
// ─────────────────────────────────────────────────────────────

async function showLangStep(chatId, bot, lang, state) {
  setStep(chatId, 'lang');
  const prefLang = getPreferredLanguage(chatId);
  const text = `${t('export.title', lang)}\n${t('export.step_2_lang', lang)}`;
  await bot.sendMessage(chatId, text, {
    parse_mode:   'MarkdownV2',
    reply_markup: langKeyboard(lang, prefLang),
  }).catch(err => logger.error({ err }, 'showLangStep failed'));
}

// ─────────────────────────────────────────────────────────────
// Show format selection (step 3/3)
// ─────────────────────────────────────────────────────────────

async function showFormatStep(chatId, bot, lang) {
  setStep(chatId, 'format');
  const text = `${t('export.title', lang)}\n${t('export.step_3_format', lang)}`;
  await bot.sendMessage(chatId, text, {
    parse_mode:   'MarkdownV2',
    reply_markup: formatKeyboard(lang),
  }).catch(err => logger.error({ err }, 'showFormatStep failed'));
}

// ─────────────────────────────────────────────────────────────
// Generate & send PDF(s)
// ─────────────────────────────────────────────────────────────

async function generateAndSend(chatId, bot, lang, state) {
  const { params } = state;
  const { dateFrom, dateTo, period } = params;
  const exportLang   = params.lang   || 'en';
  const exportFormat = params.format || 'pdf';
  const uiLang       = lang;

  setStep(chatId, 'generating');

  // "⏳ Generating..."
  await bot.sendMessage(chatId, t('export.generating', uiLang), { parse_mode: 'MarkdownV2' }).catch(() => {});

  const langs   = exportLang   === 'both' ? ['en', 'ru']     : [exportLang];
  const formats = exportFormat === 'both' ? ['pdf', 'pptx']  : [exportFormat];

  // Build all (lang × format) tasks for parallel generation
  const tasks = [];
  for (const l of langs) {
    for (const f of formats) {
      tasks.push({
        lang: l,
        format: f,
        promise: f === 'pptx'
          ? generatePptx({ period, lang: l, dateFrom, dateTo })
          : generatePdf({  period, lang: l, dateFrom, dateTo }),
      });
    }
  }

  try {
    const buffers = await Promise.all(tasks.map(t => t.promise));

    if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });

    for (let i = 0; i < tasks.length; i++) {
      const { lang: l, format: f } = tasks[i];
      const from     = (dateFrom || '').replace(/-/g, '');
      const to       = (dateTo   || '').replace(/-/g, '');
      const filename = `acrogym-${period}-${from}-to-${to}_${l}.${f}`;
      const filepath = path.join(EXPORTS_DIR, filename);

      fs.writeFileSync(filepath, buffers[i]);

      const captionKey = f === 'pptx' ? 'export.file_caption_pptx' : 'export.file_caption_pdf';
      const caption = t(captionKey, uiLang, {
        period: `${dateFrom} — ${dateTo}`,
        lang:   l.toUpperCase(),
      });

      await sendDocumentToOwner(buffers[i], filename, escapeMd(caption));
    }

    clearState(chatId);
    await bot.sendMessage(chatId, t('export.ready', uiLang), {
      parse_mode:   'MarkdownV2',
      reply_markup: backMenuKeyboard(uiLang),
    }).catch(() => {});

  } catch (err) {
    logger.error({ err }, 'generateAndSend failed');
    clearState(chatId);
    await bot.sendMessage(chatId,
      t('export.failed', uiLang, { reason: escapeMd(err.message) }),
      { parse_mode: 'MarkdownV2', reply_markup: backMenuKeyboard(uiLang) }
    ).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────
// Main export callback handler
// ─────────────────────────────────────────────────────────────

async function exportCallbackHandler(query, bot) {
  console.log('[EXPORT] handler entry, data:', JSON.stringify(query.data));

  const chatId = query.message?.chat?.id;
  console.log('[EXPORT] chatId from query.message?.chat?.id:', chatId,
    '| query.from.id:', query.from?.id,
    '| query.message exists:', !!query.message);
  if (!chatId) {
    console.log('[EXPORT] ABORT — no chatId');
    return;
  }

  const lang   = getPreferredLanguage(chatId) || 'en';
  const parts  = (query.data || '').split(':');
  const action = parts[1];
  const value  = parts[2];
  console.log('[EXPORT] parts:', JSON.stringify(parts), '| action:', action, '| value:', value, '| lang:', lang);

  // Answer immediately to close the spinner
  try { await bot.answerCallbackQuery(query.id); } catch {}

  // ── Cancel ───────────────────────────────────────────────
  console.log('[EXPORT] checking action against: cancel / period / week / month_choice / lang / format');
  if (action === 'cancel') {
    console.log('[EXPORT] MATCHED branch: cancel');
    clearState(chatId);
    await bot.sendMessage(chatId, t('export.cancelled', lang), {
      parse_mode:   'MarkdownV2',
      reply_markup: backMenuKeyboard(lang),
    }).catch(() => {});
    return;
  }

  // All other actions require active state
  const state = getState(chatId);
  console.log('[EXPORT] state:', state ? `action=${state.action} step=${state.step}` : 'NULL');

  // ── Step: period ─────────────────────────────────────────
  if (action === 'period') {
    console.log('[EXPORT] MATCHED branch: period | value:', value);

    if (value === 'day') {
      setState(chatId, 'export', 'day_choice', { period: 'day' });
      await bot.sendMessage(chatId,
        `${t('export.title', lang)}\n${t('export.step_1b_day', lang)}`,
        { parse_mode: 'MarkdownV2', reply_markup: dayChoiceKeyboard(lang) }
      ).catch(err => logger.error({ err }, 'period:day sendMessage failed'));

    } else if (value === 'week') {
      setState(chatId, 'export', 'week_choice', { period: 'week' });
      await bot.sendMessage(chatId,
        `${t('export.title', lang)}\n${t('export.step_1b_week', lang)}`,
        { parse_mode: 'MarkdownV2', reply_markup: weekChoiceKeyboard(lang) }
      ).catch(err => logger.error({ err }, 'period:week sendMessage failed'));

    } else if (value === 'month') {
      setState(chatId, 'export', 'month_choice', { period: 'month' });
      await bot.sendMessage(chatId,
        `${t('export.title', lang)}\n${t('export.step_1b_month', lang)}`,
        { parse_mode: 'MarkdownV2', reply_markup: monthChoiceKeyboard(lang) }
      ).catch(err => logger.error({ err }, 'period:month sendMessage failed'));

    } else if (value === 'custom') {
      // Custom range → calendar picker for start date
      setState(chatId, 'export', 'cal_start', { period: 'custom' });
      console.log('[EXPORT] custom → cal_start');
      const today = todayString();
      const { year, month } = currentYearMonth();
      await bot.sendMessage(chatId,
        `${t('export.title', lang)}\n${t('export.cal_title_start', lang)}`,
        { parse_mode: 'MarkdownV2', reply_markup: buildCalendarKeyboard(year, month, lang, { today }) }
      ).catch(err => logger.error({ err }, 'period:custom sendMessage failed'));

    } else {
      console.log('[EXPORT] period: UNKNOWN value:', value);
    }
    return;
  }

  // ── Step: day preset choice ───────────────────────────────
  if (action === 'day') {
    console.log('[EXPORT] MATCHED branch: day | value:', value, '| state:', state ? 'exists' : 'NULL');
    if (!state) return;
    if (await checkTimeout(state, chatId, bot, lang)) return;

    const DAYS_MAP = { yesterday: 1, '2_days_ago': 2, '3_days_ago': 3 };
    const daysBack = DAYS_MAP[value];
    if (!daysBack) { console.log('[EXPORT] day: UNKNOWN value:', value); return; }

    const { dateFrom, dateTo } = dayRange(daysBack);
    updateParams(chatId, { dateFrom, dateTo });
    console.log('[EXPORT] day picked:', dateFrom);
    await showLangStep(chatId, bot, lang, getState(chatId));
    return;
  }

  // ── Step: week preset choice ──────────────────────────────
  if (action === 'week') {
    console.log('[EXPORT] MATCHED branch: week | value:', value, '| state:', state ? 'exists' : 'NULL');
    if (!state) return;
    if (await checkTimeout(state, chatId, bot, lang)) return;

    let range;
    if      (value === 'last_week')   range = lastWeekRange();
    else if (value === 'this_week')   range = thisWeekRange();
    else if (value === '2_weeks_ago') range = twoWeeksAgoRange();
    else { console.log('[EXPORT] week: UNKNOWN value:', value); return; }

    updateParams(chatId, range);
    console.log('[EXPORT] week picked:', range.dateFrom, '→', range.dateTo);
    await showLangStep(chatId, bot, lang, getState(chatId));
    return;
  }

  // ── Step: month preset choice ─────────────────────────────
  if (action === 'month_choice') {
    console.log('[EXPORT] MATCHED branch: month_choice | value:', value, '| state:', state ? 'exists' : 'NULL');
    if (!state) return;
    if (await checkTimeout(state, chatId, bot, lang)) return;

    let range;
    if      (value === 'last_month')   range = lastMonthRange();
    else if (value === 'this_month')   range = thisMonthRange();
    else if (value === '2_months_ago') range = twoMonthsAgoRange();
    else { console.log('[EXPORT] month_choice: UNKNOWN value:', value); return; }

    updateParams(chatId, range);
    console.log('[EXPORT] month picked:', range.dateFrom, '→', range.dateTo);
    await showLangStep(chatId, bot, lang, getState(chatId));
    return;
  }

  // ── Calendar: ignore (empty cell / header tap) ────────────
  if (action === 'ignore') {
    return; // answerCallbackQuery already called above
  }

  // ── Calendar: navigate to another month (custom range only) ─
  if (action === 'nav') {
    if (!value || !/^\d{4}-\d{2}$/.test(value)) return;
    const [navYear, navMonthStr] = value.split('-');
    const today = todayString();
    console.log('[CAL] nav → month:', value);
    try {
      await bot.editMessageReplyMarkup(
        buildCalendarKeyboard(Number(navYear), Number(navMonthStr), lang, { today }),
        { chat_id: chatId, message_id: query.message.message_id }
      );
    } catch (err) {
      logger.error({ err }, 'cal:nav editMessageReplyMarkup failed');
    }
    return;
  }

  // ── Calendar: date picked (custom range only) ─────────────
  if (action === 'pick') {
    const dateStr = value;
    console.log('[CAL] pick → date:', dateStr, '| state:', state ? state.step : 'NULL');
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
    if (!state) { console.log('[CAL] pick: no state — aborting'); return; }
    if (await checkTimeout(state, chatId, bot, lang)) return;

    const today = todayString();
    if (dateStr > today) { console.log('[CAL] pick: future date ignored'); return; }

    // Delete calendar message to keep chat clean
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch {}

    if (state.step === 'cal_start') {
      updateParams(chatId, { dateFrom: dateStr });
      setStep(chatId, 'cal_end');
      console.log('[CAL] custom start:', dateStr);
      const { year, month } = currentYearMonth();
      const fromEsc = escapeMd(dateStr);
      const text = `${t('export.title', lang)}\n${t('export.cal_title_end', lang)}\n_${t('export.cal_from', lang)}: ${fromEsc}_`;
      await bot.sendMessage(chatId, text, {
        parse_mode:   'MarkdownV2',
        reply_markup: buildCalendarKeyboard(year, month, lang, { today }),
      }).catch(err => logger.error({ err }, 'cal_start → cal_end sendMessage failed'));

    } else if (state.step === 'cal_end') {
      const dateFrom = state.params.dateFrom;
      if (dateStr < dateFrom) {
        console.log('[CAL] end < start — rejected');
        await bot.sendMessage(chatId, t('export.invalid_range', lang), { parse_mode: 'MarkdownV2' }).catch(() => {});
        return;
      }
      updateParams(chatId, { dateTo: dateStr });
      console.log('[CAL] custom end:', dateStr, '| range:', dateFrom, '→', dateStr);
      await showLangStep(chatId, bot, lang, getState(chatId));

    } else {
      console.log('[CAL] pick: unexpected step:', state.step);
    }
    return;
  }

  // ── Step: lang ───────────────────────────────────────────
  if (action === 'lang') {
    console.log('[EXPORT] MATCHED branch: lang | value:', value, '| state:', state ? 'exists' : 'NULL');
    if (!state) { console.log('[EXPORT] lang: no state — aborting'); return; }
    if (await checkTimeout(state, chatId, bot, lang)) return;
    updateParams(chatId, { lang: value });
    await showFormatStep(chatId, bot, lang);
    return;
  }

  // ── Step: format ─────────────────────────────────────────
  if (action === 'format') {
    console.log('[EXPORT] MATCHED branch: format | value:', value, '| state:', state ? 'exists' : 'NULL');
    if (!state) { console.log('[EXPORT] format: no state — aborting'); return; }
    if (await checkTimeout(state, chatId, bot, lang)) return;

    if (value === 'pdf' || value === 'pptx' || value === 'both') {
      console.log('[EXPORT] format:', value, '— starting generation, state.params:', JSON.stringify(state.params));
      const merged = { ...state, params: { ...state.params, format: value } };
      await generateAndSend(chatId, bot, lang, merged);
    }
    return;
  }

  console.log('[EXPORT] NO BRANCH MATCHED for action:', JSON.stringify(action), '| full data:', JSON.stringify(query.data));
  logger.warn({ data: query.data }, 'exportCallbackHandler: unhandled action');
}

// ─────────────────────────────────────────────────────────────
// month:export_pdf — from /month command "Download as PDF" btn
// ─────────────────────────────────────────────────────────────

async function monthExportPdfHandler(query, bot) {
  const chatId = query.message?.chat?.id;
  if (!chatId) return;
  try { await bot.answerCallbackQuery(query.id); } catch {}

  const prefLang = getPreferredLanguage(chatId) || 'en';
  const { dateFrom, dateTo } = thisMonthRange();

  clearState(chatId);

  // If lang is determined (en|ru), skip to generation directly
  if (prefLang === 'en' || prefLang === 'ru') {
    setState(chatId, 'export', 'generating', {
      period: 'month', dateFrom, dateTo, lang: prefLang,
    });
    const fakeState = { params: { period: 'month', dateFrom, dateTo, lang: prefLang }, updated_at: new Date().toISOString() };
    await generateAndSend(chatId, bot, prefLang, fakeState);
  } else {
    // null or 'both' → show language picker (Step 2); UI always in English (neutral)
    setState(chatId, 'export', 'lang', { period: 'month', dateFrom, dateTo });
    await showLangStep(chatId, bot, 'en', getState(chatId));
  }
}

// ─────────────────────────────────────────────────────────────
// Text handler — date input steps
// ─────────────────────────────────────────────────────────────

async function ownerTextHandler(msg, bot) {
  const chatId = msg.chat.id;
  const text   = (msg.text || '').trim();
  const lang   = getPreferredLanguage(chatId) || 'en';
  const state  = getState(chatId);

  if (!state || state.action !== 'export') return; // not in export flow
  if (!['date_single', 'date_start', 'date_end'].includes(state.step)) return;

  if (await checkTimeout(state, chatId, bot, lang)) return;

  // Validate date
  const today = todayQatar();
  const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(text) && dayjs(text, 'YYYY-MM-DD', true).isValid();
  const isFuture    = isValidDate && text > today;

  if (!isValidDate || isFuture) {
    await bot.sendMessage(chatId, t('export.invalid_date', lang), { parse_mode: 'MarkdownV2' }).catch(() => {});
    return;
  }

  if (state.step === 'date_single') {
    updateParams(chatId, { dateFrom: text, dateTo: text });
    await showLangStep(chatId, bot, lang, getState(chatId));

  } else if (state.step === 'date_start') {
    updateParams(chatId, { dateFrom: text });
    setStep(chatId, 'date_end');
    await bot.sendMessage(chatId, t('export.prompt_date_end', lang), { parse_mode: 'MarkdownV2' }).catch(() => {});

  } else if (state.step === 'date_end') {
    const dateFrom = state.params.dateFrom;
    if (text < dateFrom) {
      await bot.sendMessage(chatId, t('export.invalid_range', lang), { parse_mode: 'MarkdownV2' }).catch(() => {});
      return;
    }
    updateParams(chatId, { dateTo: text });
    await showLangStep(chatId, bot, lang, getState(chatId));
  }
}

// ─────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────

function setupExportCallbacks() {
  registerOwnerCallback('export', exportCallbackHandler);
  registerOwnerCallback('cal',    exportCallbackHandler); // calendar nav/pick/ignore
  registerOwnerCallback('month',  (query, bot) => {
    const action = (query.data || '').split(':')[1];
    if (action === 'export_pdf') return monthExportPdfHandler(query, bot);
    // other month:* callbacks can be added here
  });
  registerOwnerTextHandler('export', ownerTextHandler);
}

module.exports = {
  setupExportCallbacks,
  // exported for unit tests (scripts/test-export-flow.js)
  _exportCallbackHandler: exportCallbackHandler,
  _ownerTextHandler:      ownerTextHandler,
  _monthExportPdfHandler: monthExportPdfHandler,
};
