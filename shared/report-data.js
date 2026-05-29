'use strict';

/**
 * shared/report-data.js — Shared report data builder.
 *
 * Fetches all DB data and computes derived values used by
 * pdf-exporter and pptx-exporter.  Does NOT render charts —
 * each exporter chooses its own dimensions and styling.
 *
 * @param {{ period, lang, dateFrom, dateTo }} opts
 * @returns {Promise<ReportData>}
 */

const {
  countLeadsInRange,
  getSourceBreakdownInRange,
  getLeadsByDayRange,
  getQualityStatsInRange,
} = require('./db');
const { createLogger } = require('./logger');

const logger = createLogger('report-data');

// ── Source palette (shared by both exporters) ────────────────
const SRC_COLORS = ['#28347F', '#F37021', '#5A6BC4', '#FF9755', '#1A2356', '#C25617'];

// ── Period-aware titles ──────────────────────────────────────
const PERIOD_TITLES = {
  en: {
    day:    { cover: 'DAILY REPORT',    summary: 'DAILY SUMMARY',     chart: 'Lead Activity — Selected Day',   footer: 'AcroGym · Daily Report'   },
    week:   { cover: 'WEEKLY REPORT',   summary: 'WEEKLY SUMMARY',    chart: 'Daily Leads — This Week',        footer: 'AcroGym · Weekly Report'  },
    month:  { cover: 'MONTHLY REPORT',  summary: 'EXECUTIVE SUMMARY', chart: 'Daily Leads — Last 4 Weeks',     footer: 'AcroGym · Monthly Report' },
    custom: { cover: 'PERIOD REPORT',   summary: 'PERIOD SUMMARY',    chart: 'Daily Leads — Selected Period',  footer: 'AcroGym · Period Report'  },
  },
  ru: {
    day:    { cover: 'ЕЖЕДНЕВНЫЙ ОТЧЁТ',  summary: 'ИТОГИ ДНЯ',       chart: 'Активность за выбранный день',       footer: 'AcroGym · Ежедневный отчёт' },
    week:   { cover: 'НЕДЕЛЬНЫЙ ОТЧЁТ',   summary: 'ИТОГИ НЕДЕЛИ',    chart: 'Лиды по дням — выбранная неделя',   footer: 'AcroGym · Недельный отчёт'  },
    month:  { cover: 'ЕЖЕМЕСЯЧНЫЙ ОТЧЁТ', summary: 'ИТОГИ МЕСЯЦА',    chart: 'Лиды по дням — последние 4 недели', footer: 'AcroGym · Месячный отчёт'   },
    custom: { cover: 'ОТЧЁТ ЗА ПЕРИОД',   summary: 'ИТОГИ ПЕРИОДА',   chart: 'Лиды по дням — выбранный период',   footer: 'AcroGym · Отчёт за период'  },
  },
};

// ── Date helpers ─────────────────────────────────────────────

/** "2026-05-27" → "May 2026" / "Май 2026" */
function formatDate(dateStr, lang) {
  const d   = new Date(dateStr + 'T00:00:00Z');
  const loc = lang === 'ru' ? 'ru-RU' : 'en-US';
  return new Intl.DateTimeFormat(loc, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

/** "2026-05-27" → "27.05" (ru) | "05/27" (en) */
function formatDateShort(dateStr, lang) {
  const [, mm, dd] = dateStr.split('-');
  return lang === 'ru' ? `${dd}.${mm}` : `${mm}/${dd}`;
}

/** "2026-05-27" → "27.05.2026" */
function formatGenerated(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

/**
 * Compute the previous period of equal duration ending the day before `dateFrom`.
 * Works uniformly for day/week/month/custom — duration-based shift.
 *
 * Example: dateFrom=2026-05-01 dateTo=2026-05-29 (29 days)
 *   → prev: dateFrom=2026-04-02 dateTo=2026-04-30 (29 days)
 *
 * @returns {{ dateFrom, dateTo } | null}
 */
function prevPeriodRange(dateFrom, dateTo) {
  if (!dateFrom || !dateTo) return null;
  const from = new Date(dateFrom + 'T00:00:00Z');
  const to   = new Date(dateTo   + 'T00:00:00Z');
  if (isNaN(from) || isNaN(to) || to < from) return null;

  const DAY = 86400000;
  const durDays = Math.round((to - from) / DAY); // 0 = same-day, 6 = week
  const prevTo   = new Date(from.getTime() - DAY);
  const prevFrom = new Date(prevTo.getTime() - durDays * DAY);
  return {
    dateFrom: prevFrom.toISOString().slice(0, 10),
    dateTo:   prevTo.toISOString().slice(0, 10),
  };
}

/**
 * Format a duration in seconds into a compact bilingual string.
 *   < 60 sec  → "< 1m" / "< 1м"
 *   1-59 min  → "Nm"   / "Nм"
 *   1+ h      → "Nh Mm" / "Nч Mм"  (or "Nh" / "Nч" when M=0)
 *  > 24h kept in hours per spec (no days).
 *
 * @param {number|null} seconds
 * @param {string} lang
 * @returns {string|null}  null when seconds is null/0/negative
 */
function formatDuration(seconds, lang = 'en') {
  if (seconds == null || seconds <= 0) return null;
  if (seconds < 60) return lang === 'ru' ? '< 1м' : '< 1m';
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return lang === 'ru' ? `${totalMin}м` : `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (m === 0) return lang === 'ru' ? `${h}ч` : `${h}h`;
  return lang === 'ru' ? `${h}ч ${m}м` : `${h}h ${m}m`;
}

/** Period-aware cover date label. */
function coverDateForPeriod(period, dateFrom, dateTo, lang) {
  const loc = lang === 'ru' ? 'ru-RU' : 'en-US';
  if (period === 'day') {
    const d = new Date(dateFrom + 'T00:00:00Z');
    return new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
  }
  if (period === 'month') {
    return formatDate(dateFrom, lang);
  }
  // week or custom: "18 мая — 24 мая 2026" / "18 May — 24 May 2026"
  const d1  = new Date(dateFrom + 'T00:00:00Z');
  const d2  = new Date(dateTo   + 'T00:00:00Z');
  const fmt = new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long', timeZone: 'UTC' });
  return `${fmt.format(d1)} — ${fmt.format(d2)} ${d2.getUTCFullYear()}`;
}

// ── Main builder ─────────────────────────────────────────────

/**
 * Fetch and derive all data needed for a report.
 *
 * @param {{ period?: string, lang?: string, dateFrom: string, dateTo: string }} opts
 * @returns {Promise<object>}
 */
async function buildReportData({ period = 'month', lang = 'en', dateFrom, dateTo } = {}) {
  // ── DB ─────────────────────────────────────────────────────
  const totalLeads = countLeadsInRange(dateFrom, dateTo);
  const rawSources = getSourceBreakdownInRange(dateFrom, dateTo);
  const dailyRows  = getLeadsByDayRange(dateFrom, dateTo);
  const quality    = getQualityStatsInRange(dateFrom, dateTo);

  // ── Period titles ──────────────────────────────────────────
  const ptLang = PERIOD_TITLES[lang] || PERIOD_TITLES.en;
  const pt     = ptLang[period]      || ptLang.month;

  // ── Source breakdown (top 4) ───────────────────────────────
  const srcLabels = rawSources.slice(0, 4).map(r => r.source);
  const srcCounts = rawSources.slice(0, 4).map(r => r.cnt);
  const srcTotal  = srcCounts.reduce((a, b) => a + b, 0) || 1;

  // ── Daily trend ────────────────────────────────────────────
  const lineLabels = dailyRows.map(r => formatDateShort(r.day, lang));
  const lineData   = dailyRows.map(r => r.cnt);

  const maxIdx = lineData.length ? lineData.indexOf(Math.max(...lineData)) : 0;
  const minIdx = lineData.length ? lineData.indexOf(Math.min(...lineData)) : 0;

  // ── Funnel ─────────────────────────────────────────────────
  const respondedCount = quality.total_responded || 0;

  // ── Response time (honest, derived from notified_at→responded_at avg) ──
  const avgResponseSeconds = (quality.avg_seconds != null && respondedCount > 0)
    ? quality.avg_seconds
    : null;

  // ── Data-presence booleans (used by exporters to choose placeholders) ──
  const hasSourceData = srcLabels.length > 0 && srcCounts.reduce((a, b) => a + b, 0) > 0;
  const hasLineData   = lineData.length   > 0 && lineData.some(v => v > 0);

  // ── Previous period comparison (generic: works for day/week/month/custom) ──
  const prevRange      = prevPeriodRange(dateFrom, dateTo);
  const prevTotal      = prevRange ? countLeadsInRange(prevRange.dateFrom, prevRange.dateTo) : 0;
  const prevDelta      = prevRange ? (totalLeads - prevTotal) : null;
  const prevDeltaPct   = (prevRange && prevTotal > 0)
    ? Math.round((prevDelta / prevTotal) * 100)
    : null;  // null = "no prior data" or division by zero

  // ── Cover strings ──────────────────────────────────────────
  const coverDateLabel = coverDateForPeriod(period, dateFrom, dateTo, lang);
  const coverGenerated = lang === 'ru' ? formatGenerated(dateTo) : dateTo;

  logger.debug(
    { period, lang, dateFrom, dateTo, totalLeads, respondedCount, hasSourceData, hasLineData, prevTotal, prevDeltaPct },
    'buildReportData complete'
  );

  return {
    // identifiers
    period, lang, dateFrom, dateTo,
    // period-aware titles { cover, summary, chart, footer }
    pt,
    // leads
    totalLeads,
    respondedCount,
    // sources
    rawSources,
    srcLabels,
    srcCounts,
    srcTotal,
    SRC_COLORS,
    hasSourceData,
    // daily trend arrays (parallel — index-aligned)
    dailyRows,
    lineLabels,
    lineData,
    maxIdx,
    minIdx,
    hasLineData,
    // quality / response time
    avgResponseSeconds,
    // previous-period comparison
    prevRange,
    prevTotal,
    prevDelta,
    prevDeltaPct,
    // formatted date strings for cover / header
    coverDateLabel,
    coverGenerated,
  };
}

module.exports = {
  buildReportData,
  // date helpers re-exported so exporters don't duplicate them
  formatDate,
  formatDateShort,
  formatGenerated,
  coverDateForPeriod,
  prevPeriodRange,
  formatDuration,
  // constants
  PERIOD_TITLES,
  SRC_COLORS,
};
