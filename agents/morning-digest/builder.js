'use strict';

const { execSync }  = require('child_process');
const path          = require('path');

const dayjs    = require('dayjs');
const utc      = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const { createLogger } = require('../../shared/logger');
const {
  getDb,
  getDailyStats,
  getTopUnanswered,
  countLeadsInRange,
  getLeadsByDay,
  getLeadsByDayOfWeek,
  getLeadsByHour,
  countTotalLeads,
  getLongPending,
} = require('../../shared/db');
const { generateText } = require('../../shared/claude');

const logger       = createLogger('morning-digest');
const TIMEZONE     = process.env.TIMEZONE || 'Asia/Qatar';
const OPENING_DATE = '2026-09-01';

const EN_DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const EN_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOW_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function formatUptime(ms) {
  if (!ms || ms < 0) return '?';
  const totalH = Math.floor(ms / 3600000);
  const d = Math.floor(totalH / 24);
  const h = totalH % 24;
  if (d > 0) return `${d}d ${h}h`;
  return `${totalH}h`;
}

function formatPhone(phone) {
  if (!phone) return '—';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('974')) {
    return `+974 ${digits.slice(3, 7)} ${digits.slice(7)}`;
  }
  return phone;
}

// ─────────────────────────────────────────────────────────────
// Section builders (each exported for independent testing)
// ─────────────────────────────────────────────────────────────

/**
 * Source breakdown for a given date (YYYY-MM-DD).
 * Returns null if source column absent or no data.
 */
function buildSourceBreakdown(yesterdayStr) {
  try {
    const db   = getDb();
    const cols = db.prepare('PRAGMA table_info(leads)').all();
    if (!cols.some(c => c.name === 'source')) return null;

    const rows = db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(source), ''), 'Unknown') as src, COUNT(*) as cnt
      FROM leads
      WHERE DATE(datetime(created_at, '+3 hours')) = ?
      GROUP BY src
      ORDER BY cnt DESC
    `).all(yesterdayStr);

    if (!rows.length) return null;
    const result = {};
    for (const { src, cnt } of rows) result[src] = cnt;
    return result;
  } catch (err) {
    logger.warn({ err }, 'buildSourceBreakdown failed');
    return null;
  }
}

/**
 * Count of leads auto-filtered as existing/returning duplicates (yesterday).
 */
function buildIdentErrors(yesterdayStr) {
  try {
    const row = getDb().prepare(`
      SELECT COUNT(*) as cnt FROM leads
      WHERE DATE(datetime(created_at, '+3 hours')) = ?
        AND status IN ('duplicate_of_existing', 'duplicate_of_returning')
    `).get(yesterdayStr);
    return row?.cnt || 0;
  } catch { return 0; }
}

/**
 * Leads pending >24h without response.
 * Returns array of { id, name, phone, hoursWaiting }.
 */
function buildLongPending() {
  try {
    return getLongPending(24).map(lead => ({
      id:           lead.id,
      name:         lead.parent_name || '—',
      phone:        lead.parent_phone,
      hoursWaiting: Math.floor((Date.now() - new Date(lead.notified_at).getTime()) / 3600000),
    }));
  } catch (err) {
    logger.warn({ err }, 'buildLongPending failed');
    return [];
  }
}

/**
 * PM2 process status via `pm2 jlist`.
 * Returns array of process objects or { error } on failure.
 */
function buildSystemStatus() {
  try {
    const pm2Bin = path.join(process.env.HOME || '/home/admin', '.npm-global/bin/pm2');
    const out    = execSync(`${pm2Bin} jlist`, { encoding: 'utf8', timeout: 5000 });
    const list   = JSON.parse(out);
    return list.map(p => ({
      name:     p.name,
      status:   p.pm2_env?.status || 'unknown',
      pid:      p.pid,
      restarts: p.pm2_env?.restart_time || 0,
      uptime:   p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : null,
    }));
  } catch (err) {
    logger.warn({ err: err.message }, 'buildSystemStatus: pm2 unavailable');
    return { error: 'pm2 unavailable' };
  }
}

/**
 * Lead count by day of week for last N days.
 * Returns { Sun: N, Mon: N, ..., Sat: N }.
 */
function buildDayOfWeek(days = 28) {
  try {
    const rows   = getLeadsByDayOfWeek(days);
    const result = Object.fromEntries(DOW_SHORT.map(d => [d, 0]));
    for (const { dow, cnt } of rows) {
      const name = DOW_SHORT[parseInt(dow, 10)];
      if (name) result[name] = cnt;
    }
    return result;
  } catch (err) {
    logger.warn({ err }, 'buildDayOfWeek failed');
    return Object.fromEntries(DOW_SHORT.map(d => [d, 0]));
  }
}

/**
 * Lead count by hour of day for last N days.
 * Returns array of 24 numbers (index = hour 0-23).
 */
function buildTimeOfDay(days = 28) {
  try {
    const rows   = getLeadsByHour(days);
    const result = new Array(24).fill(0);
    for (const { hour, cnt } of rows) result[parseInt(hour, 10)] = cnt;
    return result;
  } catch (err) {
    logger.warn({ err }, 'buildTimeOfDay failed');
    return new Array(24).fill(0);
  }
}

/**
 * Generates a single AI insight via Claude API.
 * Returns string or null on failure (non-blocking).
 */
async function buildInsight(stats) {
  try {
    const systemPrompt =
      'You are a business analyst for AcroGym, a children\'s gymnastics center in Qatar opening September 2026. ' +
      'Given yesterday\'s stats and 7-day trends, write ONE concise insight (1-2 sentences) that highlights ' +
      'something noteworthy: an anomaly, a pattern, a risk, or an opportunity. Be specific (use numbers). ' +
      'No fluff, no generic advice. If data is too sparse for meaningful insight — say exactly: ' +
      '"Not enough data yet for meaningful insights."';

    return await generateText({
      system:    systemPrompt,
      user:      JSON.stringify(stats, null, 2),
      maxTokens: 200,
      model:     'claude-sonnet-4-5',
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'buildInsight: Claude API failed — skipping insight block');
    return null;
  }
}

/**
 * Renders the 3 standard charts and returns array of PNG Buffers.
 * Returns [] on failure — does not block digest delivery.
 */
async function renderCharts(chartData) {
  try {
    const { renderLineChart, renderBarChart, renderHeatmap } = require('../../shared/chart');
    const [c1, c2, c3] = await Promise.all([
      renderLineChart({
        title:  '7-Day Lead Trend',
        labels: chartData.trend.labels,
        data:   chartData.trend.data,
      }),
      renderBarChart({
        title:  'Leads by Day of Week (28d)',
        labels: DOW_SHORT,
        data:   DOW_SHORT.map(d => chartData.dayOfWeek[d] || 0),
      }),
      renderHeatmap({
        title: 'Leads by Hour of Day (28d)',
        data:  chartData.timeOfDay,
      }),
    ]);
    return [c1, c2, c3];
  } catch (err) {
    logger.warn({ err: err.message }, 'renderCharts failed — digest will be sent without charts');
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Main digest builder
// ─────────────────────────────────────────────────────────────

/**
 * Builds the full digest payload.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRun=false]
 * @param {boolean} [opts.withCharts=false]  — render chart PNGs
 * @returns {Promise<DigestPayload>}
 */
async function buildDigest({ dryRun = false, withCharts = false } = {}) {
  const now          = dayjs().tz(TIMEZONE);
  const yesterday    = now.subtract(1, 'day');
  const yesterdayStr = yesterday.format('YYYY-MM-DD');

  // ── Yesterday stats ───────────────────────────────────────
  const stats = getDailyStats(yesterdayStr);

  const byType = {};
  for (const { client_type, cnt } of stats.byType) byType[client_type] = cnt;

  const newCount       = byType['new']      || 0;
  const existingCount  = byType['existing'] || 0;
  const returningCount = byType['returning']|| 0;
  const unknownCount   = byType['unknown']  || 0;
  const totalCount     = newCount + existingCount + returningCount + unknownCount;

  const topUnanswered    = getTopUnanswered(3);
  const oldestUnanswered = topUnanswered[0] || null;

  // ── 7-day trend ───────────────────────────────────────────
  const last7Start = now.subtract(7, 'day').format('YYYY-MM-DD');
  const last7End   = yesterday.format('YYYY-MM-DD');
  const prev7Start = now.subtract(14, 'day').format('YYYY-MM-DD');
  const prev7End   = now.subtract(8, 'day').format('YYYY-MM-DD');

  const last7Count = countLeadsInRange(last7Start, last7End);
  const prev7Count = countLeadsInRange(prev7Start, prev7End);
  const avgPerDay  = last7Count > 0 ? last7Count / 7 : 0;

  // ── Goal tracking ─────────────────────────────────────────
  const opening          = dayjs(OPENING_DATE).tz(TIMEZONE);
  const daysLeft         = opening.diff(now.startOf('day'), 'day');
  const TARGET_STUDENTS  = 300;
  const TARGET_CONV      = 0.26;
  const neededLeads      = Math.round(TARGET_STUDENTS / TARGET_CONV);
  const totalAccumulated = countTotalLeads();
  const remaining        = Math.max(0, neededLeads - totalAccumulated);
  const requiredPace     = daysLeft > 0 ? (remaining / daysLeft).toFixed(1) : '?';

  let forecastStatus;
  if (avgPerDay >= parseFloat(requiredPace))             forecastStatus = '🟢 On track';
  else if (avgPerDay >= parseFloat(requiredPace) * 0.7)  forecastStatus = '🟡 Slightly below target';
  else                                                    forecastStatus = '🔴 Behind target';

  // ── New sections ──────────────────────────────────────────
  const sourceBreakdown = buildSourceBreakdown(yesterdayStr);
  const identErrors     = buildIdentErrors(yesterdayStr);
  const longPending     = buildLongPending();
  const systemStatus    = buildSystemStatus();
  const dowData         = buildDayOfWeek(28);
  const todData         = buildTimeOfDay(28);

  // ── Chart raw data ────────────────────────────────────────
  const last7Days   = getLeadsByDay(7);
  const allLabels   = Array.from({ length: 7 }, (_, i) =>
    now.subtract(7 - i, 'day').format('MM-DD')
  );
  const last7Map    = Object.fromEntries(last7Days.map(r => [r.day.slice(5), r.cnt]));
  const chartData   = {
    trend:     { labels: allLabels, data: allLabels.map(d => last7Map[d] || 0) },
    dayOfWeek: dowData,
    timeOfDay: todData,
  };

  // ── Insight (Claude) ──────────────────────────────────────
  const insightStats = {
    yesterday: { total: totalCount, new: newCount, existing: existingCount, returning: returningCount, unknown: unknownCount },
    response:  { responded: stats.responded, unanswered: stats.unanswered },
    trend_7d:  { total: last7Count, avg_per_day: +avgPerDay.toFixed(1), vs_prev7: prev7Count },
    pending:   { today: stats.unanswered, long_24h: longPending.length },
    goal:      { days_left: daysLeft, accumulated: totalAccumulated, needed: neededLeads, required_pace: requiredPace },
  };
  const insightText = await buildInsight(insightStats);

  // ── Chart buffers ─────────────────────────────────────────
  let chartBuffers = [];
  if (withCharts) chartBuffers = await renderCharts(chartData);

  // ─────────────────────────────────────────────────────────
  // Build HTML text — new English format (ЭТАП 5)
  // ─────────────────────────────────────────────────────────

  const dateStr = `${now.date()} ${EN_MONTHS[now.month()]} ${now.year()}, ${EN_DAYS[now.day()]} — Doha time`;
  const dryMark = dryRun ? '\n<i>[DRY RUN — not sent to Telegram]</i>' : '';

  let text = `🤸 <b>AcroGym Daily Digest</b>${dryMark}\n`;
  text    += `<i>${dateStr}</i>\n\n`;

  // Yesterday Overview
  text += `📊 <b>Yesterday Overview</b>\n`;
  if (totalCount === 0) {
    text += `• No submissions received yesterday.\n`;
  } else {
    text += `• Total submissions: ${totalCount}\n`;
    if (newCount)       text += `• New leads: ${newCount}\n`;
    if (existingCount)  text += `• Existing T&C: ${existingCount}\n`;
    if (returningCount) text += `• Returning: ${returningCount}\n`;
    if (unknownCount)   text += `• Type unknown: ${unknownCount}\n`;
    if (identErrors > 0) text += `• Duplicates filtered: ${identErrors}\n`;
  }
  text += '\n';

  // Sources (only if data exists)
  if (sourceBreakdown && Object.keys(sourceBreakdown).length > 0) {
    text += `📍 <b>Sources</b>\n`;
    for (const [src, cnt] of Object.entries(sourceBreakdown)) {
      text += `• ${src}: ${cnt}\n`;
    }
    text += '\n';
  }

  // Form errors (only if > 0)
  if (identErrors > 0) {
    text += `⚠️ <b>Form errors</b>\n`;
    text += `• ${identErrors} existing client${identErrors > 1 ? 's' : ''} marked as "New" — auto-filtered.\n\n`;
  }

  // Operational Health
  if (newCount > 0 || topUnanswered.length > 0) {
    text += `⚡ <b>Operational Health</b>\n`;
    if (newCount > 0) {
      text += `• Responded: ${stats.responded}/${newCount} (${Math.round(stats.responded / newCount * 100)}%)\n`;
      if (stats.unanswered > 0) {
        text += `• Still pending: ${stats.unanswered}\n`;
      } else {
        text += `• All leads responded ✅\n`;
      }
    }
    if (oldestUnanswered) {
      const h = now.diff(dayjs(oldestUnanswered.notified_at), 'hour');
      text += `• Oldest pending: ${oldestUnanswered.parent_name || '—'} — ${h}h waiting\n`;
    }
    text += '\n';
  }

  // Long pending >24h
  if (longPending.length > 0) {
    text += `🚨 <b>Long pending (&gt;24h)</b>\n`;
    for (const lp of longPending) text += `• ${lp.name} — ${lp.hoursWaiting}h\n`;
    text += '\n';
  }

  // Goal Tracking
  text += `🎯 <b>Goal Tracking</b>\n`;
  text += `• Days until launch (1 Sep 2026): ${daysLeft}\n`;
  text += `• Total leads accumulated: ${totalAccumulated} / target ${neededLeads}\n`;
  if (avgPerDay > 0) {
    text += `• Required pace: ${requiredPace} leads/day from now\n`;
    text += `• Status: ${forecastStatus}\n`;
  } else {
    text += `• Status: 📊 Not enough data for projection yet\n`;
  }
  text += '\n';

  // Insight
  if (insightText) {
    text += `💡 <b>Insight of the day</b>\n<i>${insightText}</i>\n\n`;
  }

  // System status
  text += `🤖 <b>System</b>\n`;
  if (Array.isArray(systemStatus) && systemStatus.length > 0) {
    for (const p of systemStatus) {
      const icon  = p.status === 'online' ? '🟢' : p.status === 'stopped' ? '🔴' : '🟡';
      const up    = p.uptime ? formatUptime(p.uptime) : '?';
      const rst   = p.restarts > 0 ? `, restarts ${p.restarts}` : '';
      text += `• ${p.name}: ${icon} ${p.status} (uptime ${up}${rst})\n`;
    }
  } else {
    text += `• ⚠️ PM2 status unavailable\n`;
  }

  return {
    text,
    topUnanswered,
    copyCallbacks: topUnanswered.map((l, i) => ({ index: i, leadId: l.id, name: l.parent_name })),
    longPending,
    systemStatus,
    chartBuffers,
    chartData,
    insightText,
  };
}

module.exports = {
  buildDigest,
  buildSourceBreakdown,
  buildIdentErrors,
  buildLongPending,
  buildSystemStatus,
  buildDayOfWeek,
  buildTimeOfDay,
  buildInsight,
  renderCharts,
};
