'use strict';

/**
 * builders/weekly-builder.js — недельный срез (ЗАДАЧА 2 / ПОДЭТАП А).
 *
 * Разделы:
 *   1. Заголовок (title, subtitle, диапазон дат)
 *   2. Обзор (total, типы, лучший/худший день)
 *   3. Источники (source breakdown)
 *   4. Качество реакции (avg time, within-hour, pending >24h)
 *   5. Воронка (leads + заглушки до in2)
 *   6. Цель (дней до открытия, темп, статус)
 *   7. Инсайт (Claude, двуязычный JSON {en, ru})
 *
 * Графики (при withCharts=true):
 *   1. Эта неделя vs прошлая (grouped bar) → renderWeeklyComparison
 *   2. Источники (bar)                     → renderBarChart
 *   3. Тренд 4 недели (line)               → renderLineChart
 */

const dayjs = require('dayjs');
const utc   = require('dayjs/plugin/utc');
const tz    = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

const { createLogger }     = require('../../../shared/logger');
const { createTranslator } = require('../../../shared/i18n');
const { escapeMd }         = require('../../../shared/telegram');
const { generateText }     = require('../../../shared/claude');
const {
  countLeadsInRange,
  getTypeBreakdownInRange,
  getSourceBreakdownInRange,
  getQualityStatsInRange,
  getLeadsByDayRange,
  getLeadsByDay,
  countTotalLeads,
} = require('../../../shared/db');

const logger       = createLogger('owner-bot');
const TIMEZONE     = process.env.TIMEZONE || 'Asia/Qatar';
const OPENING_DATE = '2026-09-01';

// Goal constants (mirrors daily-builder.js)
const TARGET_STUDENTS = 300;
const TARGET_CONV     = 0.26;
const NEEDED_LEADS    = Math.round(TARGET_STUDENTS / TARGET_CONV); // ~1154

// dayjs.day() → day_names key mapping (0 = Sunday)
const DOW_KEYS  = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
// Chart axis labels (always EN, used in PNG — no MDv2 escaping needed)
const DOW_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Format seconds → "Xh Ym" | "Ym" | "Xs" | "—"
 */
function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.round(seconds)}s`;
}

// ─────────────────────────────────────────────────────────────
// Claude insight (bilingual)
// ─────────────────────────────────────────────────────────────

async function buildWeeklyInsight(stats) {
  try {
    const raw = await Promise.race([
      generateText({
        system:
          'You are a business analyst for AcroGym, a children\'s gymnastics center opening in Qatar in September 2026. ' +
          'Given the weekly lead stats, write ONE concise insight (1–3 sentences) highlighting something noteworthy: ' +
          'a pattern, trend, risk, or opportunity. Be specific (use numbers). No fluff, no generic advice. ' +
          'If data is too sparse for a meaningful insight, say exactly: "Not enough data yet for meaningful insights." ' +
          'Respond ONLY with valid JSON in this exact shape: {"en": "<english text>", "ru": "<russian text>"}',
        user:      JSON.stringify(stats, null, 2),
        maxTokens: 300,
        model:     'claude-opus-4-8',
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Claude insight timeout (15s)')), 15000)
      ),
    ]);

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]);
    return {
      en: String(parsed.en || '').trim(),
      ru: String(parsed.ru || parsed.en || '').trim(),
    };
  } catch (err) {
    logger.warn({ err: err.message }, '[weekly] buildWeeklyInsight: Claude API failed — skipping insight');
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Charts
// ─────────────────────────────────────────────────────────────

async function renderWeeklyCharts({ thisWeekDays, prevWeekDays, sourceRows, trend28 }) {
  const { renderWeeklyComparison, renderBarChart, renderLineChart } = require('../../../shared/chart');
  const buffers = [];

  // Chart 1: this week vs last week (grouped bar) — skip if no data at all
  if (thisWeekDays.length > 0 || prevWeekDays.length > 0) {
    try {
      const thisMap = Object.fromEntries(thisWeekDays.map(r => [dayjs(r.day).format('ddd'), r.cnt]));
      const prevMap = Object.fromEntries(prevWeekDays.map(r => [dayjs(r.day).format('ddd'), r.cnt]));
      buffers.push(await renderWeeklyComparison({
        title:         'This Week vs Last Week',
        labels:        DOW_SHORT,
        current_week:  DOW_SHORT.map(d => thisMap[d] || 0),
        previous_week: DOW_SHORT.map(d => prevMap[d] || 0),
      }));
    } catch (err) {
      logger.warn({ err: err.message }, '[weekly] chart 1 (comparison) failed');
    }
  }

  // Chart 2: source breakdown bar chart
  try {
    if (sourceRows.length > 0) {
      buffers.push(await renderBarChart({
        title:  'Source Breakdown (this week)',
        labels: sourceRows.map(r => r.source),
        data:   sourceRows.map(r => r.cnt),
      }));
    }
  } catch (err) {
    logger.warn({ err: err.message }, '[weekly] chart 2 (sources) failed');
  }

  // Chart 3: 4-week daily trend (line)
  try {
    if (trend28.length > 0) {
      buffers.push(await renderLineChart({
        title:  'Daily Leads Trend (last 4 weeks)',
        labels: trend28.map(r => r.day.slice(5)),  // MM-DD — chart PNG, no MDv2 escaping
        data:   trend28.map(r => r.cnt),
      }));
    }
  } catch (err) {
    logger.warn({ err: err.message }, '[weekly] chart 3 (trend) failed');
  }

  return buffers;
}

// ─────────────────────────────────────────────────────────────
// Main builder
// ─────────────────────────────────────────────────────────────

/**
 * Build weekly slice payload.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.lang='en']
 * @param {boolean} [opts.withCharts=false]
 * @param {boolean} [opts.dryRun=false]
 * @returns {Promise<{text: string, chartBuffers: Buffer[], insightBilingual: object|null}>}
 */
async function buildWeeklySlice({ lang = 'en', withCharts = false, dryRun = false } = {}) {
  const tr  = createTranslator(lang);
  const now = dayjs().tz(TIMEZONE);

  // Rolling 7-day window: D-7 to D-1 (this week) and D-14 to D-8 (previous)
  const thisStart = now.subtract(7,  'day').format('YYYY-MM-DD');
  const thisEnd   = now.subtract(1,  'day').format('YYYY-MM-DD');
  const prevStart = now.subtract(14, 'day').format('YYYY-MM-DD');
  const prevEnd   = now.subtract(8,  'day').format('YYYY-MM-DD');

  // ── Collect data ──────────────────────────────────────────
  const thisWeekTotal = countLeadsInRange(thisStart, thisEnd);
  const prevWeekTotal = countLeadsInRange(prevStart, prevEnd);

  // Type breakdown
  const typeRows = getTypeBreakdownInRange(thisStart, thisEnd);
  const byType   = {};
  for (const { client_type, cnt } of typeRows) byType[client_type] = cnt;
  const newCount       = byType['new']       || 0;
  const existingCount  = byType['existing']  || 0;
  const returningCount = byType['returning'] || 0;

  // Day-of-week stats for best/worst
  const thisWeekDays = getLeadsByDayRange(thisStart, thisEnd);
  const prevWeekDays = getLeadsByDayRange(prevStart, prevEnd);

  let bestDay = null, worstDay = null;
  if (thisWeekDays.length > 0) {
    const sorted   = [...thisWeekDays].sort((a, b) => b.cnt - a.cnt);
    bestDay        = sorted[0];
    const withData = sorted.filter(r => r.cnt > 0);
    if (withData.length > 1) worstDay = withData[withData.length - 1];
  }

  // Sources
  const sourceRows  = getSourceBreakdownInRange(thisStart, thisEnd);
  const sourceTotal = sourceRows.reduce((s, r) => s + r.cnt, 0);

  // Quality
  const quality = getQualityStatsInRange(thisStart, thisEnd);

  // Goal tracking
  const opening          = dayjs(OPENING_DATE).tz(TIMEZONE);
  const daysLeft         = Math.max(0, opening.diff(now.startOf('day'), 'day'));
  const totalAccumulated = countTotalLeads();
  const remaining        = Math.max(0, NEEDED_LEADS - totalAccumulated);
  const weekPace         = (thisWeekTotal / 7).toFixed(1);
  const requiredPace     = daysLeft > 0 ? (remaining / daysLeft).toFixed(1) : '?';

  // Goal status
  const reqNum  = parseFloat(requiredPace) || 0;
  const wkNum   = parseFloat(weekPace);
  let statusEmoji, statusKey;
  if (!reqNum || wkNum >= reqNum)          { statusEmoji = '🟢'; statusKey = 'weekly.status_text_on_track'; }
  else if (wkNum >= reqNum * 0.7)          { statusEmoji = '🟡'; statusKey = 'weekly.status_text_below'; }
  else                                      { statusEmoji = '🔴'; statusKey = 'weekly.status_text_critical'; }

  // 4-week trend for chart 3
  const trend28 = getLeadsByDay(28);

  // ── Claude insight (skip in dryRun) ──────────────────────
  const insightStats = {
    this_week:   { total: thisWeekTotal, new: newCount, existing: existingCount, returning: returningCount },
    prev_week:   { total: prevWeekTotal },
    quality:     { avg_seconds: quality.avg_seconds, within_hour: quality.within_hour, total_responded: quality.total_responded, pending_24h: quality.pending_24h },
    goal:        { days_left: daysLeft, accumulated: totalAccumulated, needed: NEEDED_LEADS, weekly_pace: weekPace, required_pace: requiredPace },
    top_sources: sourceRows.slice(0, 3).map(r => ({ source: r.source, count: r.cnt })),
  };
  const insightBilingual = dryRun ? null : await buildWeeklyInsight(insightStats);

  // ── Charts (only if requested) ────────────────────────────
  let chartBuffers = [];
  if (withCharts) {
    chartBuffers = await renderWeeklyCharts({ thisWeekDays, prevWeekDays, sourceRows, trend28 });
  }

  // ─────────────────────────────────────────────────────────
  // Build MarkdownV2 text
  // Static i18n strings are pre-escaped for MDv2.
  // Dynamic values go through escapeMd().
  // ─────────────────────────────────────────────────────────
  const monthObj = tr.tObj('month_names');
  const dayObj   = tr.tObj('day_names');

  // Subtitle date range: "DD Month — DD Month"
  const fromDay = dayjs(thisStart).tz(TIMEZONE);
  const toDay   = dayjs(thisEnd).tz(TIMEZONE);
  const fromStr = `${fromDay.date()} ${monthObj[String(fromDay.month() + 1)] || fromDay.format('MMM')}`;
  const toStr   = `${toDay.date()} ${monthObj[String(toDay.month() + 1)] || toDay.format('MMM')}`;

  const dryMark = dryRun ? '\n_dry run_' : '';

  let text = tr.t('weekly.title') + dryMark + '\n';
  text += tr.t('weekly.subtitle', {
    from: escapeMd(fromStr),
    to:   escapeMd(toStr),
  }) + '\n\n';

  // ── Overview ──────────────────────────────────────────────
  text += tr.t('weekly.section_overview') + '\n';

  const deltaAbs  = thisWeekTotal - prevWeekTotal;
  const deltaSign = deltaAbs >= 0 ? escapeMd('+') : '\\-';
  const deltaPct  = prevWeekTotal > 0
    ? Math.abs(Math.round(deltaAbs / prevWeekTotal * 100))
    : 0;

  text += tr.t('weekly.overview_total_vs', {
    this_week:     thisWeekTotal,
    last_week:     prevWeekTotal,
    delta_sign:    deltaSign,
    delta_percent: deltaPct,
  }) + '\n';

  if (thisWeekTotal > 0) {
    text += tr.t('weekly.overview_by_type', {
      new:       newCount,
      existing:  existingCount,
      returning: returningCount,
    }) + '\n';
  }

  if (bestDay && bestDay.cnt > 0) {
    const bdDow  = dayjs(bestDay.day).day(); // 0=Sun
    const bdName = dayObj[DOW_KEYS[bdDow]] || DOW_KEYS[bdDow];
    text += tr.t('weekly.overview_best_day', {
      day:   escapeMd(bdName),
      count: bestDay.cnt,
    }) + '\n';
  }

  if (worstDay && bestDay && worstDay.day !== bestDay.day) {
    const wdDow  = dayjs(worstDay.day).day();
    const wdName = dayObj[DOW_KEYS[wdDow]] || DOW_KEYS[wdDow];
    text += tr.t('weekly.overview_worst_day', {
      day:   escapeMd(wdName),
      count: worstDay.cnt,
    }) + '\n';
  }
  text += '\n';

  // ── Sources ───────────────────────────────────────────────
  if (sourceRows.length > 0) {
    text += tr.t('weekly.section_sources') + '\n';
    for (const { source, cnt } of sourceRows) {
      const pct = sourceTotal > 0 ? Math.round(cnt / sourceTotal * 100) : 0;
      text += tr.t('weekly.source_line', {
        source:  escapeMd(source),
        count:   cnt,
        percent: pct,
      }) + '\n';
    }
    text += '\n';
  }

  // ── Quality ───────────────────────────────────────────────
  text += tr.t('weekly.section_quality') + '\n';
  text += tr.t('weekly.quality_avg_response', {
    time: escapeMd(formatDuration(quality.avg_seconds)),
  }) + '\n';
  if (quality.total_responded > 0) {
    const withinPct = Math.round(quality.within_hour / quality.total_responded * 100);
    text += tr.t('weekly.quality_within_hour', {
      within:  quality.within_hour,
      total:   quality.total_responded,
      percent: withinPct,
    }) + '\n';
  }
  text += tr.t('weekly.quality_pending_24', { count: quality.pending_24h }) + '\n';
  text += '\n';

  // ── Funnel (placeholders until in2 integration) ───────────
  text += tr.t('weekly.section_funnel') + '\n';
  text += tr.t('weekly.funnel_leads',          { count: newCount }) + '\n';
  text += tr.t('weekly.funnel_trial_booked',   { placeholder: '—' }) + '\n';
  text += tr.t('weekly.funnel_trial_attended', { placeholder: '—' }) + '\n';
  text += tr.t('weekly.funnel_subscribed',     { placeholder: '—' }) + '\n';
  text += '\n';

  // ── Goal ──────────────────────────────────────────────────
  text += tr.t('weekly.section_goal') + '\n';
  text += tr.t('weekly.goal_days_left',      { days: daysLeft }) + '\n';
  text += tr.t('weekly.goal_accumulated',    { current: totalAccumulated, target: NEEDED_LEADS }) + '\n';
  text += tr.t('weekly.goal_last_week_pace', { pace: escapeMd(weekPace) }) + '\n';
  text += tr.t('weekly.goal_required_pace',  { pace: escapeMd(String(requiredPace)) }) + '\n';
  text += tr.t('weekly.goal_status', {
    status_emoji: statusEmoji,
    status_text:  escapeMd(tr.t(statusKey)),
  }) + '\n';
  text += '\n';

  // ── Insight ───────────────────────────────────────────────
  if (insightBilingual) {
    const insightTxt = lang === 'ru' ? insightBilingual.ru : insightBilingual.en;
    if (insightTxt) {
      text += tr.t('weekly.section_insight') + '\n';
      text += escapeMd(insightTxt) + '\n';
    }
  }

  return {
    text,
    lang,
    chartBuffers,
    insightBilingual,
    statsSnapshot: insightStats,
  };
}

module.exports = { buildWeeklySlice };
