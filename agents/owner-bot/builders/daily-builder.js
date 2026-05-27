'use strict';

const { execSync }  = require('child_process');
const path          = require('path');

const dayjs    = require('dayjs');
const utc      = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const { createLogger }    = require('../../../shared/logger');
const { createTranslator } = require('../../../shared/i18n');
const { escapeMd }        = require('../../../shared/telegram');
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
  getAllPending,
  getYesterdayResponded,
} = require('../../../shared/db');
const { generateText } = require('../../../shared/claude');

const logger       = createLogger('owner-bot');
const TIMEZONE     = process.env.TIMEZONE || 'Asia/Qatar';
const OPENING_DATE = '2026-09-01';

// Short day labels for charts (always EN — chart axis labels)
const DOW_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// dayjs.day() → day_names key mapping (0=Sunday)
const DOW_KEYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Format uptime milliseconds → "2d 5h" or "5h" (language-aware short suffixes).
 */
function formatUptime(ms, tr) {
  if (!ms || ms < 0) return '?';
  const totalH = Math.floor(ms / 3600000);
  const d = Math.floor(totalH / 24);
  const h = totalH % 24;
  const ds = tr.t('common.uptime.days_short');
  const hs = tr.t('common.uptime.hours_short');
  if (d > 0) return `${d}${ds} ${h}${hs}`;
  return `${totalH}${hs}`;
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
// Section builders (exported for independent testing)
// ─────────────────────────────────────────────────────────────

function buildSourceBreakdown(yesterdayStr) {
  try {
    const db   = getDb();
    const cols = db.prepare('PRAGMA table_info(leads)').all();
    if (!cols.some(c => c.name === 'source')) return null;

    const rows = db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(source), ''), 'Unknown') as src, COUNT(*) as cnt
      FROM leads
      WHERE DATE(datetime(created_at, '+3 hours')) = ?
        AND client_type != 'legacy'
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

async function buildInsight(stats) {
  try {
    const systemPrompt =
      'You are a business analyst for AcroGym, a children\'s gymnastics center in Qatar opening September 2026. ' +
      'Given yesterday\'s stats and 7-day trends, write ONE concise insight (1-2 sentences) that highlights ' +
      'something noteworthy: an anomaly, a pattern, a risk, or an opportunity. Be specific (use numbers). ' +
      'No fluff, no generic advice. If data is too sparse for meaningful insight — say exactly: ' +
      '"Not enough data yet for meaningful insights."';

    return await Promise.race([
      generateText({
        system:    systemPrompt,
        user:      JSON.stringify(stats, null, 2),
        maxTokens: 200,
        model:     'claude-sonnet-4-5',
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Claude insight timeout (15s)')), 15000)
      ),
    ]);
  } catch (err) {
    logger.warn({ err: err.message }, 'buildInsight: Claude API failed — skipping insight block');
    return null;
  }
}

function buildAllPending() {
  try {
    return getAllPending(50, 0).map(lead => {
      const h = Math.floor((Date.now() - new Date(lead.notified_at).getTime()) / 3600000);
      let urgency = '';
      if (h >= 24) urgency = '🚨';
      else if (h >= 8) urgency = '⚠️';
      return {
        id:           lead.id,
        name:         lead.parent_name || '—',
        phone:        lead.parent_phone || null,
        hoursWaiting: h,
        urgency,
        hasGreeting:  !!lead.generated_greeting,
      };
    });
  } catch (err) {
    logger.warn({ err }, 'buildAllPending failed');
    return [];
  }
}

function buildYesterdayResponded(dateStr) {
  try {
    return getYesterdayResponded(dateStr).map(lead => ({
      id:          lead.id,
      name:        lead.parent_name || '—',
      phone:       lead.parent_phone || null,
      respondedAt: lead.responded_at
        ? dayjs(lead.responded_at).tz(TIMEZONE).format('HH:mm')
        : '—',
    }));
  } catch (err) {
    logger.warn({ err }, 'buildYesterdayResponded failed');
    return [];
  }
}

async function renderCharts(chartData) {
  try {
    const { renderLineChart, renderBarChart, renderHeatmap } = require('../../../shared/chart');
    const [c1, c2, c3] = await Promise.all([
      renderLineChart({
        title:  'Last 7 days — leads per day',
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
 * Builds the full digest payload (MarkdownV2 text + data).
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRun=false]
 * @param {boolean} [opts.withCharts=false]
 * @param {string}  [opts.lang='en']          - 'en' | 'ru'
 * @returns {Promise<DigestPayload>}
 */
async function buildDigest({ dryRun = false, withCharts = false, lang = 'en' } = {}) {
  const tr = createTranslator(lang);

  const now          = dayjs().tz(TIMEZONE);
  const yesterday    = now.subtract(1, 'day');
  const yesterdayStr = yesterday.format('YYYY-MM-DD');

  // ── Yesterday stats ───────────────────────────────────────
  const stats = getDailyStats(yesterdayStr);

  const byType = {};
  for (const { client_type, cnt } of stats.byType) byType[client_type] = cnt;

  const newCount       = byType['new']       || 0;
  const existingCount  = byType['existing']  || 0;
  const returningCount = byType['returning'] || 0;
  const totalCount     = newCount + existingCount + returningCount + (byType['unknown'] || 0);

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
  const opening         = dayjs(OPENING_DATE).tz(TIMEZONE);
  const daysLeft        = opening.diff(now.startOf('day'), 'day');
  const TARGET_STUDENTS = 300;
  const TARGET_CONV     = 0.26;
  const neededLeads     = Math.round(TARGET_STUDENTS / TARGET_CONV);
  const totalAccumulated = countTotalLeads();
  const remaining        = Math.max(0, neededLeads - totalAccumulated);
  const requiredPace     = daysLeft > 0 ? (remaining / daysLeft).toFixed(1) : '?';

  // Goal status — full translated string (already has bullet)
  let forecastStatus;
  if (avgPerDay >= parseFloat(requiredPace))            forecastStatus = tr.t('daily.goal_status_green');
  else if (avgPerDay >= parseFloat(requiredPace) * 0.7) forecastStatus = tr.t('daily.goal_status_yellow');
  else                                                   forecastStatus = tr.t('daily.goal_status_red');

  // ── New sections ──────────────────────────────────────────
  const sourceBreakdown    = buildSourceBreakdown(yesterdayStr);
  const identErrors        = buildIdentErrors(yesterdayStr);
  const longPending        = buildLongPending();
  const allPending         = buildAllPending();
  const yesterdayResponded = buildYesterdayResponded(yesterdayStr);
  const systemStatus       = buildSystemStatus();
  const dowData            = buildDayOfWeek(28);
  const todData            = buildTimeOfDay(28);

  // ── Chart raw data ────────────────────────────────────────
  const last7Days = getLeadsByDay(7);
  const allLabels = Array.from({ length: 7 }, (_, i) =>
    now.subtract(7 - i, 'day').format('MM-DD')
  );
  const last7Map  = Object.fromEntries(last7Days.map(r => [r.day.slice(5), r.cnt]));
  const chartData = {
    trend:     { labels: allLabels, data: allLabels.map(d => last7Map[d] || 0) },
    dayOfWeek: dowData,
    timeOfDay: todData,
  };

  // ── Insight (Claude, always English) ─────────────────────
  const insightStats = {
    yesterday: { total: totalCount, new: newCount, existing: existingCount, returning: returningCount },
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
  // Build MarkdownV2 text
  // Static i18n strings are pre-escaped for MarkdownV2.
  // Dynamic values go through escapeMd().
  // ─────────────────────────────────────────────────────────

  // Date components
  const monthObj  = tr.tObj('month_names');
  const dayObj    = tr.tObj('day_names');
  const monthName = monthObj[String(now.month() + 1)] || String(now.month() + 1);
  const dayName   = dayObj[DOW_KEYS[now.day()]] || DOW_KEYS[now.day()];
  const dateStr   = `${now.date()} ${monthName} ${now.year()}`;

  const dryMark = dryRun ? '\n_dry run_' : '';

  let text = tr.t('daily.title') + dryMark + '\n';

  // Date line (dynamic values escaped before insertion)
  text += tr.t('daily.date_line', {
    date:      escapeMd(dateStr),
    day_name:  escapeMd(dayName),
    doha_time: tr.t('common.doha_time'),  // pure letters, no escape needed
  }) + '\n\n';

  // ── Yesterday Overview ────────────────────────────────────
  text += tr.t('daily.section_overview') + '\n';
  if (totalCount === 0) {
    text += tr.t('daily.overview_empty') + '\n';
  } else {
    text += tr.t('daily.overview_total',     { count: totalCount })    + '\n';
    if (newCount)       text += tr.t('daily.overview_new',       { count: newCount })       + '\n';
    if (existingCount)  text += tr.t('daily.overview_existing',  { count: existingCount })  + '\n';
    if (returningCount) text += tr.t('daily.overview_returning', { count: returningCount }) + '\n';
    if (identErrors > 0) text += tr.t('daily.overview_duplicates', { count: identErrors })  + '\n';
  }
  text += '\n';

  // ── Sources ───────────────────────────────────────────────
  if (sourceBreakdown && Object.keys(sourceBreakdown).length > 0) {
    text += tr.t('daily.section_sources') + '\n';
    for (const [src, cnt] of Object.entries(sourceBreakdown)) {
      text += `• ${escapeMd(src)}: ${cnt}\n`;
    }
    text += '\n';
  }

  // ── Form errors ───────────────────────────────────────────
  if (identErrors > 0) {
    text += tr.t('daily.section_errors') + '\n';
    text += tr.t('daily.errors_existing_as_new', { count: identErrors }) + '\n\n';
  }

  // ── Operational Health ────────────────────────────────────
  if (newCount > 0 || topUnanswered.length > 0 || allPending.length > 0) {
    text += tr.t('daily.section_health') + '\n';
    if (newCount > 0) {
      const pct = Math.round(stats.responded / newCount * 100);
      text += tr.t('daily.health_responded', {
        responded: stats.responded,
        total:     newCount,
        percent:   pct,
      }) + '\n';
      if (stats.unanswered > 0) {
        text += tr.t('daily.health_pending', { count: stats.unanswered }) + '\n';
      }
    }
    if (oldestUnanswered) {
      const h = now.diff(dayjs(oldestUnanswered.notified_at), 'hour');
      text += tr.t('daily.health_oldest_pending', {
        name:  escapeMd(oldestUnanswered.parent_name || '—'),
        hours: h,
      }) + '\n';
    }
    text += '\n';
  }

  // ── Responded yesterday ───────────────────────────────────
  if (yesterdayResponded.length > 0) {
    text += tr.t('daily.section_responded_yesterday') + '\n';
    text += tr.t('daily.responded_count', { count: yesterdayResponded.length }) + '\n\n';
  }

  // ── Long pending >24h ─────────────────────────────────────
  if (longPending.length > 0) {
    text += tr.t('daily.section_long_pending') + '\n';
    for (const lp of longPending) {
      text += tr.t('daily.long_pending_item', {
        name:  escapeMd(lp.name),
        hours: lp.hoursWaiting,
      }) + '\n';
    }
    text += '\n';
  }

  // ── Goal Tracking ─────────────────────────────────────────
  text += tr.t('daily.section_goal') + '\n';
  text += tr.t('daily.goal_days_left',    { days: daysLeft }) + '\n';
  text += tr.t('daily.goal_accumulated',  { current: totalAccumulated, target: neededLeads }) + '\n';
  if (avgPerDay > 0) {
    text += tr.t('daily.goal_pace_required', { pace: escapeMd(requiredPace) }) + '\n';
    text += forecastStatus + '\n';
  } else {
    text += tr.t('common.no_data_yet') + '\n';
  }
  text += '\n';

  // ── Insight ───────────────────────────────────────────────
  if (insightText) {
    text += tr.t('daily.section_insight') + '\n';
    text += escapeMd(insightText) + '\n\n';
  }

  // ── System Status ─────────────────────────────────────────
  text += tr.t('daily.section_system') + '\n';
  if (Array.isArray(systemStatus) && systemStatus.length > 0) {
    for (const p of systemStatus) {
      const up = p.uptime ? formatUptime(p.uptime, tr) : '?';
      if (p.status === 'online') {
        text += tr.t('daily.system_online', {
          agent:    escapeMd(p.name),
          uptime:   escapeMd(up),
          restarts: p.restarts,
        }) + '\n';
      } else {
        text += tr.t('daily.system_offline', { agent: escapeMd(p.name) }) + '\n';
      }
    }
  } else {
    text += tr.t('daily.system_offline', { agent: 'pm2' }) + '\n';
  }

  return {
    text,
    lang,
    topUnanswered,
    allPending,
    yesterdayResponded,
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
  buildAllPending,
  buildYesterdayResponded,
  buildSystemStatus,
  buildDayOfWeek,
  buildTimeOfDay,
  buildInsight,
  renderCharts,
  formatUptime,
};
