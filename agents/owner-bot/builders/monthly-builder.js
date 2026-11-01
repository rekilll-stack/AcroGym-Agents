'use strict';

/**
 * builders/monthly-builder.js — месячный отчёт владельцу (Telegram + экран «Отчёты → Месяц» в Джарвисе).
 *
 * 01.11 переписан по жалобе владельца «половина неправильно подсчитано»:
 *   - лиды, источники, время ответа — из нашей БД (как было);
 *   - занятия, дети на занятиях, загрузка, ЗП — из Payroll панели in2 (shared/in2.payrollPeriod):
 *     публичный API не помнит записи прошедших занятий («0 посещений»), а прежний сбор обрезал месяц на 200 занятиях;
 *   - деньги, активные дети, пробные, воронка лидов, продления — из моста Джарвиса (те же расчёты, что в приложении);
 *   - убраны счётчики «до открытия» (цель 1154 лида, дней до открытия) — после 01.09 они ничего не значили.
 * Любой источник может не ответить — его строки просто не выводятся.
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
  getSourceBreakdownInRange,
  getQualityStatsInRange,
} = require('../../../shared/db');

const logger   = createLogger('owner-bot');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Qatar';
const BRIDGE   = '/home/admin/mcp-servers/jarvis-schedule/bridge.js'; /* тонкий MCP-клиент моста Джарвиса по localhost */

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
// Section builders (plain objects; text is assembled below)
// ─────────────────────────────────────────────────────────────

/* Светофор месяца — к прошлому месяцу по лидам и полученным деньгам (цели года — в отчёте совета директоров). */
function buildExecSummary({ monthTotal, prevMonthTotal, received, prevReceived, activeKids }) {
  const ups = [monthTotal >= prevMonthTotal];
  if (received != null && prevReceived != null) ups.push(received >= prevReceived);
  const up = ups.filter(Boolean).length;
  const statusKey = up === ups.length ? 'monthly.exec_status_green' : up === 0 ? 'monthly.exec_status_red' : 'monthly.exec_status_yellow';
  return { statusKey, monthTotal, prevMonthTotal, received, prevReceived, activeKids };
}

function buildLeadsSection({ monthTotal, sourceRows, funnel, trials }) {
  return { total: monthTotal, sources: sourceRows, funnel: funnel || null,
           trials: trials ? { total: trials.total, bought: trials.bought } : null };
}

function buildGymSection({ pay, events, money }) {
  const out = { available: !!(pay || money), payroll: !!pay };
  if (money) Object.assign(out, { received: money.received, invoiced: money.invoiced, debt: money.debt || {},
    activeKids: money.activeKids, activePackages: money.activePackages });
  if (!pay) return out;
  const slots = new Map((events || []).map((e) => [e.id, Number(e.slots) || 0]));
  const all = pay.flatMap((t) => t.classes);
  const kids = all.reduce((s, c) => s + c.kids, 0);
  const places = all.reduce((s, c) => s + (slots.get(c.idEvent) || 0), 0);
  const byDate = new Map();
  for (const c of all) byDate.set(c.date, (byDate.get(c.date) || 0) + c.kids);
  const payOf = (t) => t.salary + t.earnings;
  const coaches = pay.filter((t) => t.classes.length).map((t) => ({ name: t.name, classes: t.classes.length,
    kids: t.classes.reduce((s, c) => s + c.kids, 0), pay: payOf(t), salary: t.salary })).sort((x, y) => y.kids - x.kids);
  return Object.assign(out, { classes: all.length, kids, empty: all.filter((c) => !c.kids).length,
    utilization: places ? Math.round(kids / places * 100) : null,
    visitsByDate: [...byDate.entries()].sort((x, y) => x[0].localeCompare(y[0])), coaches,
    payCoaches: coaches.reduce((s, t) => s + t.pay, 0),
    payStaff: pay.filter((t) => !t.classes.length).reduce((s, t) => s + payOf(t), 0) });
}

function buildHealthSection({ quality }) {
  return {
    avg_seconds:     quality.avg_seconds,
    total_responded: quality.total_responded,
    within_hour:     quality.within_hour,
    pending_24h:     quality.pending_24h,
  };
}

// ─────────────────────────────────────────────────────────────
// Format helpers
// ─────────────────────────────────────────────────────────────

function formatDuration(seconds, lang = 'en') {
  if (!seconds || seconds < 0) return '—';
  const [hU, mU, sU] = lang === 'ru' ? [' ч', ' мин', ' с'] : ['h', 'm', 's'];
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}${hU} ${m}${mU}`;
  if (m > 0) return `${m}${mU}`;
  return `${Math.round(seconds)}${sU}`;
}

const num = (x, lang) => Math.round(Number(x) || 0).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US').replace(/[  ]/g, ' ');
/* ru: 1 занятие / 2 занятия / 5 занятий; en: 1 class / 2 classes */
const plural = (count, forms, lang) => {
  const k = Math.abs(count) % 100, d = k % 10;
  if (lang !== 'ru') return forms[count === 1 ? 0 : 1];
  return forms[k > 10 && k < 20 ? 2 : d === 1 ? 0 : d >= 2 && d <= 4 ? 1 : 2];
};
const dec = (x, lang) => (Number(x) || 0).toFixed(1).replace('.', lang === 'ru' ? ',' : '.');

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
 * @returns {Promise<{text: string, pdfBuffer: null, pptxBuffer: null, sections: object, in2charts: Buffer[]}>}
 */
// from/to/prevFrom/prevTo — любой период (онлайн-дашборд совета директоров в Джарвисе); без них — месяц month.
async function buildMonthlyReport({ lang = 'en', month, from, to, prevFrom, prevTo, dryRun = false, hasAttachments = false } = {}) {
  const tr = createTranslator(lang);
  const { monthStart, monthEnd, label: monthLabel } = from && to
    ? { monthStart: from, monthEnd: to, label: dayjs(from).startOf('month') }
    : resolveMonthRange(month);

  const prevLabel      = monthLabel.subtract(1, 'month');
  const prevMonthStart = prevFrom || prevLabel.format('YYYY-MM-DD');
  const prevMonthEnd   = prevTo || prevLabel.endOf('month').format('YYYY-MM-DD');
  const nextLabel      = monthLabel.add(1, 'month');

  // ── Наша БД: лиды ─────────────────────────────────────────
  const monthTotal     = countLeadsInRange(monthStart, monthEnd);
  const prevMonthTotal = countLeadsInRange(prevMonthStart, prevMonthEnd);
  const sourceRows     = getSourceBreakdownInRange(monthStart, monthEnd);
  const quality        = getQualityStatsInRange(monthStart, monthEnd);

  // ── in2 Payroll + мост Джарвиса ───────────────────────────
  const in2 = require('../../../shared/in2');
  const soft = (name, fn) => Promise.resolve().then(fn).catch((err) => {
    logger.warn({ err: err.message }, `[monthly] ${name} unavailable — lines hidden`);
    return null;
  });
  const bridge = (tool, a, b) => soft(tool, () => require(BRIDGE).call(tool, { dateFrom: a, dateTo: b }).then(JSON.parse));
  const [pay, events, money, prevMoney, trials, leadStats, ren, renNext] = await Promise.all([
    soft('payroll', () => in2.payrollPeriod(monthStart, monthEnd)),
    soft('events', () => in2.eventsRange(monthStart, monthEnd)),
    bridge('money', monthStart, monthEnd),
    bridge('money', prevMonthStart, prevMonthEnd),
    bridge('trials_range', monthStart, monthEnd),
    bridge('lead_stats', monthStart, monthEnd),
    bridge('renewals_list', monthStart, monthEnd),
    bridge('renewals_list', nextLabel.format('YYYY-MM-DD'), nextLabel.endOf('month').format('YYYY-MM-DD')),
  ]);

  const gym = buildGymSection({ pay, events, money });
  const sections = {
    exec:     buildExecSummary({ monthTotal, prevMonthTotal, received: money && money.received,
                                 prevReceived: prevMoney && prevMoney.received, activeKids: gym.activeKids }),
    leads:    buildLeadsSection({ monthTotal, sourceRows, funnel: leadStats && leadStats.sources && leadStats.sources.all, trials }),
    gym,
    renewals: ren ? ren.kpi : { available: false },
    health:   buildHealthSection({ quality }),
    outlook:  { nextEnding: renNext ? renNext.soon.length + renNext.ended.length : null, notRenewed: ren ? ren.kpi.lost : null },
  };

  const monthObj  = tr.tObj('month_names');
  const monthName = monthObj[String(monthLabel.month() + 1)] || monthLabel.format('MMMM');
  const nextName  = monthObj[String(nextLabel.month() + 1)] || nextLabel.format('MMMM');
  const year      = monthLabel.year();
  const L = (key, vars) => escapeMd(tr.t('monthly.' + key, vars));
  const n = (x) => num(x, lang);
  const pl = (count, what) => plural(count, tr.tObj('monthly.pl_' + what) || ['', '', ''], lang);

  // ── Графики (только когда есть что рисовать) ──
  const in2charts = [];
  if (!dryRun && gym.kids > 0) {
    try {
      const { renderLineChart, renderBarChart } = require('../../../shared/chart');
      if (gym.visitsByDate.length > 1) {
        in2charts.push(await renderLineChart({
          title: tr.t('charts.gym_visits_trend'),
          labels: gym.visitsByDate.map(([d]) => d.slice(5)),
          data: gym.visitsByDate.map(([, v]) => v),
        }));
      }
      if (gym.coaches.length > 1) {
        in2charts.push(await renderBarChart({
          title: tr.t('charts.gym_trainers'),
          labels: gym.coaches.slice(0, 8).map((t) => t.name.split(' ')[0]),
          data: gym.coaches.slice(0, 8).map((t) => t.kids),
        }));
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[monthly] in2 charts skipped');
    }
  }

  const vsPrev = (cur, prev) => {
    if (prev == null) return null;
    if (!prev) return cur > 0 ? tr.t('monthly.exec_first_month') : null;
    const d = cur - prev;
    return tr.t('monthly.exec_vs_prev_month', { count: n(prev), sign: d >= 0 ? escapeMd('+') : '\\-', percent: Math.abs(Math.round(d / prev * 100)) });
  };

  let text = tr.t('monthly.title') + (dryRun ? '\n_dry run_' : '') + '\n';
  text += tr.t('monthly.subtitle', { month_name: escapeMd(monthName), year }) + '\n\n';

  // ── Итоги месяца ──────────────────────────────────────────
  const ex = sections.exec;
  text += `*${escapeMd(tr.t('monthly.section_exec'))}*\n`;
  text += escapeMd(tr.t(ex.statusKey)) + '\n';
  text += `• ${escapeMd(tr.t('monthly.exec_headline_leads'))}: *${monthTotal}*\n`;
  const vsLeads = vsPrev(monthTotal, prevMonthTotal);
  if (vsLeads) text += `  _${vsLeads}_\n`;
  if (ex.received != null) {
    text += `• ${L('exec_received')}: *${escapeMd(n(ex.received))} QAR*\n`;
    const vsCash = vsPrev(ex.received, ex.prevReceived);
    if (vsCash) text += `  _${vsCash}_\n`;
  }
  if (ex.activeKids != null) text += `• ${L('exec_active_kids')}: *${ex.activeKids}*\n`;
  text += '\n';

  // ── Лиды и продажи ────────────────────────────────────────
  const ld = sections.leads;
  text += `*${escapeMd(tr.t('monthly.section_leads'))}*\n`;
  text += `• ${escapeMd(tr.t('monthly.leads_funnel_stage_submitted'))}: ${monthTotal}\n`;
  if (ld.funnel) text += `  ↳ ${L('leads_funnel_line', { cards: ld.funnel.cards, trials: ld.funnel.trials, bought: ld.funnel.bought, revenue: n(ld.funnel.revenue) })}\n`;
  if (ld.trials && ld.trials.total) {
    text += `• ${L('leads_trials_line', { total: ld.trials.total, bought: ld.trials.bought, pct: Math.round(ld.trials.bought / ld.trials.total * 100) })}\n`;
  }
  if (sourceRows.length > 0) {
    const srcTotal = sourceRows.reduce((s, r) => s + r.cnt, 0);
    text += `\n*${escapeMd(tr.t('monthly.leads_sources_title'))}*\n`;
    for (const { source, cnt } of sourceRows.slice(0, 5)) {
      const pct = srcTotal > 0 ? Math.round(cnt / srcTotal * 100) : 0;
      const key = 'monthly.src_' + source, name = tr.t(key);
      text += `• ${escapeMd(name === key ? source : name)}: ${cnt} \\(${pct}%\\)\n`;
    }
  }
  text += '\n';

  // ── Зал ───────────────────────────────────────────────────
  if (gym.available) {
    text += `*${escapeMd(tr.t('monthly.section_gym'))}*\n`;
    if (gym.payroll) {
      text += `• ${L('gym_classes_line', { classes: gym.classes, kids: n(gym.kids), avg: dec(gym.classes ? gym.kids / gym.classes : 0, lang) })}\n`;
      if (gym.utilization != null) text += `• ${L('gym_load_line', { pct: gym.utilization, empty: gym.empty })}\n`;
    } else {
      text += `• ${L('gym_no_payroll')}\n`;
    }
    if (gym.received != null) text += `• ${L('gym_money_line', { received: n(gym.received), invoiced: n(gym.invoiced) })}\n`;
    if (gym.debt && gym.debt.overdue > 0) text += `• ⚠️ ${L('gym_overdue_line', { sum: n(gym.debt.overdue), families: gym.debt.families, fw: pl(gym.debt.families, 'families') })}\n`;
    if (gym.payroll && gym.coaches.length) {
      text += `*${L('gym_coaches_title')}*\n`;
      gym.coaches.forEach((t, i) => {
        const sal = t.salary ? ` \\(${L('gym_salary_word')}${t.pay > t.salary ? ' ' + escapeMd(n(t.salary)) : ''}\\)` : '';
        text += `${i + 1}\\. ${L('gym_coach_line', { name: t.name, classes: t.classes, cw: pl(t.classes, 'classes'), kids: n(t.kids), kw: pl(t.kids, 'kids'), pay: n(t.pay) })}${sal}\n`;
      });
      text += `• ${L('gym_payroll_total', { total: n(gym.payCoaches + gym.payStaff), coaches: n(gym.payCoaches), staff: n(gym.payStaff) })}\n`;
    }
    if (gym.activeKids != null) text += `• ${L('gym_active_kids', { kids: gym.activeKids, packages: gym.activePackages })}\n`;
    if (ren) {
      const k = sections.renewals;
      text += `• ${L('gym_renewals', { renewed: k.renewed, lost: k.lost, pending: k.pending })}\n`;
    }
    text += '\n';
  }

  // ── Операционное здоровье ─────────────────────────────────
  text += `*${escapeMd(tr.t('monthly.section_health'))}*\n`;
  text += `• ${escapeMd(tr.t('monthly.health_response_time'))}: ${escapeMd(formatDuration(quality.avg_seconds, lang))}\n`;
  text += `• ${tr.t('monthly.health_pending_24h')}: ${quality.pending_24h}\n`;
  if (quality.total_responded > 0) {
    text += `• ${L('health_within_hour', { n: quality.within_hour, total: quality.total_responded, pct: Math.round(quality.within_hour / quality.total_responded * 100) })}\n`;
    text += `  _${L('health_note')}_\n`;
  }
  text += '\n';

  // ── Следующий месяц ───────────────────────────────────────
  const ol = sections.outlook;
  if (ol.nextEnding != null || ol.notRenewed) {
    text += `*${escapeMd(tr.t('monthly.section_outlook'))}*\n`;
    if (ol.nextEnding != null) text += `• ${L('outlook_expiring_next', { month: nextName, count: ol.nextEnding })}\n`;
    if (ol.notRenewed) text += `• ${L('outlook_not_renewed', { month: lang === 'ru' ? monthName.toLowerCase() : monthName, count: ol.notRenewed })}\n`;
    text += '\n';
  }

  // ── Footer ─────────────────────────────────────────────────
  text += hasAttachments
    ? `_${escapeMd(tr.t('monthly.telegram_summary_header'))}_\n`
    : tr.t('monthly.summary_no_attachments_yet') + '\n';

  return { in2charts, text, lang, pdfBuffer: null, pptxBuffer: null, sections };
}

module.exports = { buildMonthlyReport };
