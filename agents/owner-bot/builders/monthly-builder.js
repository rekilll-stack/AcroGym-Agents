'use strict';

/**
 * builders/monthly-builder.js — месячный отчёт (ЗАДАЧА 3 / ПОДЭТАП А).
 *
 * 7 внутренних секций (структурированные объекты, для PDF/PPTX в ЭТАП 7/8):
 *   1. buildExecSummary   — статус, ключевые цифры
 *   2. buildLeadsSection  — воронка, источники, конверсии
 *   3. buildAttendanceSection — посещаемость (placeholder — нужен in2)
 *   4. buildRevenueSection    — выручка (placeholder — нужен in2)
 *   5. buildCoachesSection    — тренеры (placeholder — нужен in2)
 *   6. buildHealthSection     — время ответа, pendng >24h, аптайм
 *   7. buildOutlookSection    — цель, прогноз (placeholder частично)
 *
 * Telegram summary: секции 1, 2, 6, 7 (то что реально из БД).
 * PDF/PPTX: TODO ЭТАП 7/8 — pdfBuffer и pptxBuffer всегда null.
 */

const dayjs = require('dayjs');
const utc   = require('dayjs/plugin/utc');
const tz    = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

const { createLogger }     = require('../../../shared/logger');
const { createTranslator } = require('../../../shared/i18n');
const { escapeMd }         = require('../../../shared/telegram');
const {
  countLeadsInRange,
  getTypeBreakdownInRange,
  getSourceBreakdownInRange,
  getQualityStatsInRange,
  countTotalLeads,
} = require('../../../shared/db');

const logger       = createLogger('owner-bot');
const TIMEZONE     = process.env.TIMEZONE || 'Asia/Qatar';
const OPENING_DATE = '2026-09-01';

const TARGET_STUDENTS = 300;
const TARGET_CONV     = 0.26;
const NEEDED_LEADS    = Math.round(TARGET_STUDENTS / TARGET_CONV); // ~1154

// ─────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────

/**
 * Parse opts.month (YYYY-MM) or default to last calendar month.
 * Returns { monthStart: 'YYYY-MM-DD', monthEnd: 'YYYY-MM-DD', label: dayjs }
 */
function resolveMonthRange(month) {
  const now = dayjs().tz(TIMEZONE);
  let label;
  if (month) {
    label = dayjs(month + '-01', 'YYYY-MM-DD');
  } else {
    label = now.subtract(1, 'month').startOf('month');
  }
  return {
    monthStart: label.format('YYYY-MM-DD'),
    monthEnd:   label.endOf('month').format('YYYY-MM-DD'),
    label,
  };
}

// ─────────────────────────────────────────────────────────────
// Section builders (return plain JS objects — data for PDF/PPTX)
// ─────────────────────────────────────────────────────────────

function buildExecSummary({ monthTotal, prevMonthTotal, totalAccumulated, daysLeft, requiredPace, monthlyPace }) {
  const reqNum = parseFloat(requiredPace) || 0;
  const mNum   = parseFloat(monthlyPace);

  let statusKey;
  if (!reqNum || mNum >= reqNum)       statusKey = 'monthly.exec_status_green';
  else if (mNum >= reqNum * 0.7)       statusKey = 'monthly.exec_status_yellow';
  else                                  statusKey = 'monthly.exec_status_red';

  return {
    statusKey,
    monthTotal,
    prevMonthTotal,
    totalAccumulated,
    daysLeft,
    requiredPace,
    monthlyPace,
  };
}

function buildLeadsSection({ monthTotal, typeBreakdown, sourceRows }) {
  const byType = {};
  for (const { client_type, cnt } of typeBreakdown) byType[client_type] = cnt;
  return {
    total:       monthTotal,
    new:         byType['new']       || 0,
    existing:    byType['existing']  || 0,
    returning:   byType['returning'] || 0,
    sources:     sourceRows,
    // funnel stages requiring in2:
    trialBooked:   null,
    trialAttended: null,
    subscribed:    null,
  };
}

function buildAttendanceSection() {
  // Requires in2 integration (ЭТАП 8)
  return { available: false };
}

function buildRevenueSection() {
  // Requires in2 integration (ЭТАП 8)
  return { available: false };
}

function buildCoachesSection() {
  // Requires in2 integration (ЭТАП 8)
  return { available: false };
}

function buildHealthSection({ quality }) {
  return {
    avg_seconds:     quality.avg_seconds,
    total_responded: quality.total_responded,
    within_hour:     quality.within_hour,
    pending_24h:     quality.pending_24h,
  };
}

function buildOutlookSection({ daysLeft, totalAccumulated, requiredPace }) {
  return {
    daysLeft,
    totalAccumulated,
    needed:       NEEDED_LEADS,
    requiredPace,
  };
}

// ─────────────────────────────────────────────────────────────
// Format helper
// ─────────────────────────────────────────────────────────────

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.round(seconds)}s`;
}

// ─────────────────────────────────────────────────────────────
// Main builder
// ─────────────────────────────────────────────────────────────

/**
 * Build monthly report payload.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.lang='en']           — language
 * @param {string}  [opts.month]               — YYYY-MM; defaults to last calendar month
 * @param {boolean} [opts.dryRun=false]
 * @param {boolean} [opts.hasAttachments=false] — true when PDF/PPTX are actually attached
 * @param {boolean} [opts.withPdf=false]        — TODO ЭТАП 7
 * @param {boolean} [opts.withPptx=false]       — TODO ЭТАП 8
 * @returns {Promise<{text: string, pdfBuffer: null, pptxBuffer: null, sections: object}>}
 */
async function buildMonthlyReport({ lang = 'en', month, dryRun = false, hasAttachments = false, withPdf = false, withPptx = false } = {}) {
  const tr = createTranslator(lang);
  const now = dayjs().tz(TIMEZONE);

  const { monthStart, monthEnd, label: monthLabel } = resolveMonthRange(month);

  // Previous month range for comparison
  const prevLabel     = monthLabel.subtract(1, 'month');
  const prevMonthStart = prevLabel.format('YYYY-MM-DD');
  const prevMonthEnd   = prevLabel.endOf('month').format('YYYY-MM-DD');

  // ── Data collection ───────────────────────────────────────
  const monthTotal     = countLeadsInRange(monthStart, monthEnd);
  const prevMonthTotal = countLeadsInRange(prevMonthStart, prevMonthEnd);
  const typeBreakdown  = getTypeBreakdownInRange(monthStart, monthEnd);
  const sourceRows     = getSourceBreakdownInRange(monthStart, monthEnd);
  const quality        = getQualityStatsInRange(monthStart, monthEnd);

  // Goal
  const opening          = dayjs(OPENING_DATE).tz(TIMEZONE);
  const daysLeft         = Math.max(0, opening.diff(now.startOf('day'), 'day'));
  const totalAccumulated = countTotalLeads();
  const remaining        = Math.max(0, NEEDED_LEADS - totalAccumulated);
  const monthsLeft       = Math.max(1, Math.ceil(daysLeft / 30));
  const targetPerMonth   = Math.ceil(remaining / monthsLeft);
  const monthlyPace      = monthTotal.toFixed(1);
  const requiredPace     = targetPerMonth.toFixed(1);

  // ── Build section objects ─────────────────────────────────
  const sections = {
    exec:       buildExecSummary({ monthTotal, prevMonthTotal, totalAccumulated, daysLeft, requiredPace, monthlyPace }),
    leads:      buildLeadsSection({ monthTotal, typeBreakdown, sourceRows }),
    attendance: buildAttendanceSection(),
    revenue:    buildRevenueSection(),
    coaches:    buildCoachesSection(),
    health:     buildHealthSection({ quality }),
    outlook:    buildOutlookSection({ daysLeft, totalAccumulated, requiredPace }),
  };

  // ─────────────────────────────────────────────────────────
  // Build MarkdownV2 Telegram summary (4 sections: exec, leads, health, outlook)
  // ─────────────────────────────────────────────────────────
  const monthObj  = tr.tObj('month_names');
  const monthName = monthObj[String(monthLabel.month() + 1)] || monthLabel.format('MMMM');
  const year      = monthLabel.year();

  const dryMark = dryRun ? '\n_dry run_' : '';

  let text = tr.t('monthly.title') + dryMark + '\n';
  text += tr.t('monthly.subtitle', {
    month_name: escapeMd(monthName),
    year:       year,
  }) + '\n\n';

  // ── Section 1: Exec summary ───────────────────────────────
  text += `*${escapeMd(tr.t('monthly.section_exec'))}*\n`;
  text += tr.t(sections.exec.statusKey) + '\n';
  text += `• ${escapeMd(tr.t('monthly.exec_headline_leads'))}: *${monthTotal}*\n`;

  const mDelta    = monthTotal - prevMonthTotal;
  const deltaSign = mDelta >= 0 ? escapeMd('+') : '\\-';

  let vsLine;
  if (prevMonthTotal === 0 && monthTotal > 0) {
    // First month with actual data — no meaningful % comparison
    vsLine = tr.t('monthly.exec_first_month');
  } else {
    const deltaPct = prevMonthTotal > 0
      ? Math.abs(Math.round(mDelta / prevMonthTotal * 100))
      : 0;
    vsLine = tr.t('monthly.exec_vs_prev_month', {
      count:   prevMonthTotal,
      sign:    deltaSign,
      percent: deltaPct,
    });
  }
  text += `  _${vsLine}_\n`;
  text += '\n';

  // ── Section 2: Leads ──────────────────────────────────────
  text += `*${escapeMd(tr.t('monthly.section_leads'))}*\n`;
  const { new: newC, existing: existC, returning: retC } = sections.leads;
  text += `• ${escapeMd(tr.t('monthly.leads_funnel_stage_submitted'))}: ${monthTotal}\n`;
  if (newC)  text += `  ↳ new: ${newC}`;
  if (existC) text += ` / existing: ${existC}`;
  if (retC)   text += ` / returning: ${retC}`;
  if (newC || existC || retC) text += '\n';

  if (sourceRows.length > 0) {
    const srcTotal = sourceRows.reduce((s, r) => s + r.cnt, 0);
    text += `\n*${escapeMd(tr.t('monthly.leads_sources_title'))}*\n`;
    for (const { source, cnt } of sourceRows.slice(0, 5)) {
      const pct = srcTotal > 0 ? Math.round(cnt / srcTotal * 100) : 0;
      text += `• ${escapeMd(source)}: ${cnt} \\(${pct}%\\)\n`;
    }
  }
  text += '\n';

  // ── Section 3: Health ─────────────────────────────────────
  text += `*${escapeMd(tr.t('monthly.section_health'))}*\n`;
  text += `• ${escapeMd(tr.t('monthly.health_response_time'))}: ${escapeMd(formatDuration(quality.avg_seconds))}\n`;
  text += `• ${tr.t('monthly.health_pending_24h')}: ${quality.pending_24h}\n`;
  if (quality.total_responded > 0) {
    const pct = Math.round(quality.within_hour / quality.total_responded * 100);
    text += `• Responded within 1h: ${quality.within_hour}/${quality.total_responded} \\(${pct}%\\)\n`;
  }
  text += '\n';

  // ── Section 4: Goal / Outlook ─────────────────────────────
  text += `*${escapeMd(tr.t('monthly.section_outlook'))}*\n`;
  text += `• ${escapeMd(tr.t('monthly.outlook_targets'))}: ${tr.t('monthly.outlook_leads_target', { count: escapeMd(requiredPace) })}\n`;
  text += `• ${tr.t('monthly.outlook_pipeline', {
    current: totalAccumulated,
    target:  NEEDED_LEADS,
    percent: Math.round(totalAccumulated / NEEDED_LEADS * 100),
  })}\n`;
  text += `• ${tr.t('monthly.outlook_days_until_launch', { days: daysLeft })}\n`;
  text += '\n';

  // ── Footer ─────────────────────────────────────────────────
  if (hasAttachments) {
    // PDF/PPTX are actually attached below this message
    text += `_${escapeMd(tr.t('monthly.telegram_summary_header'))}_\n`;
  } else {
    // Attachments not yet generated — point to /export command
    text += tr.t('monthly.summary_no_attachments_yet') + '\n';
  }

  if (withPdf || withPptx) {
    logger.warn('[monthly-builder] PDF/PPTX generation not yet implemented (ЭТАП 7/8)');
  }

  return {
    text,
    lang,
    pdfBuffer:  null,
    pptxBuffer: null,
    sections,
  };
}

module.exports = { buildMonthlyReport };
