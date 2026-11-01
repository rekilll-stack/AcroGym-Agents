'use strict';

/**
 * agents/board/collect.js — факты месяца для «совета директоров» (только чтение).
 *
 * Источники — те же, что у месячного отчёта и Джарвиса, ничего не пересчитываем заново:
 *   - месячный отчёт (builders/monthly-builder.js, sections) за месяц и за прошлый — Payroll in2, деньги, пробные, продления;
 *   - мост Джарвиса: unit_economics (прибыль «заработано», постоянные, разовые), progress_dash;
 *   - продления по тренерам: пакеты из снимка моста + тренер = у кого ребёнок чаще был за срок пакета (архив броней моста);
 *   - ошибки админов: скидка ровно 100 (зачёт пробного) без пробного — логика аудита 29.10 (#2057);
 *   - скорость ответа на заявки: наша БД, ночь считается с 9:00 (shared/workhours).
 */

const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');

const in2 = require('../../shared/in2');
const { effectiveNotifiedMs } = require('../../shared/workhours');
const { buildMonthlyReport } = require('../owner-bot/builders/monthly-builder');

const BR = '/home/admin/mcp-servers/jarvis-bridge';
const bridge = (tool, args) => require('/home/admin/mcp-servers/jarvis-schedule/bridge.js').call(tool, args).then(JSON.parse);
const soft = (p) => p.catch((e) => ({ error: String(e.message || e).slice(0, 200) }));
const TM = /^(term|monthly)/i;
/* Рыночная оплата управляющего (для «прибыли как у франшизы»): прямых данных по детским спортцентрам Катара нет —
   верх диапазона 5–11 тыс. QAR по объявлениям и средняя у facilities manager в Дохе (GulfTalent). ОЦЕНКА, уточнить у рекрутера. */
const MARKET_PAY = { manager: 11000, note: 'оценка: 5–11 тыс. QAR по объявлениям fitness manager в Катаре, средняя facilities manager в Дохе 11 000 (GulfTalent)',
  sources: ['https://gulftalent.com/mobile/qatar/salaries/doha/facilities-manager', 'https://app.qureos.com/jobs/manager-1758790659430'] };
const LOST_DAYS = 7; /* как renewals() в мосте: закончился больше недели назад и не продлил — «не продлили» */

/* Продления по тренерам: пакеты term/monthly с окончанием в месяце. */
async function coachRenewals(from, to, today) {
  const snap = JSON.parse(fs.readFileSync(BR + '/.changes-snap.json', 'utf8'));
  const occ = JSON.parse(fs.readFileSync(BR + '/.occ-bookings.json', 'utf8'));
  const ev = await in2.eventsRange('2026-09-01', to);
  const evm = new Map(ev.map((e) => [e.id, { d: String(e.startDate).split('/').reverse().join('-'), tr: e.trainerName }]));
  const visits = {};
  for (const [oid, kids] of Object.entries(occ)) {
    const e = evm.get(+oid); if (!e) continue;
    for (const k of kids) if (k.id) (visits[k.id] = visits[k.id] || []).push(e);
  }
  const coachOf = (cid, a, b) => {
    const cnt = {};
    for (const v of visits[cid] || []) if (v.d >= a && v.d <= b) cnt[v.tr] = (cnt[v.tr] || 0) + 1;
    return Object.entries(cnt).sort((x, y) => y[1] - x[1])[0]?.[0] || null;
  };
  const lostBefore = dayjs(today).subtract(LOST_DAYS, 'day').format('YYYY-MM-DD');
  const by = {}, tot = { renewed: 0, lost: 0, pending: 0 };
  for (const [cid, ms] of Object.entries(snap.mem || {})) {
    const tm = ms.filter((m) => TM.test(m.n || '') && m.exp).sort((a, b) => a.exp.localeCompare(b.exp));
    tm.forEach((m, i) => {
      if (m.exp < from || m.exp > to || m.exp >= today) return;
      const out = tm.slice(i + 1).some((x) => x.exp > m.exp) ? 'renewed' : m.exp < lostBefore ? 'lost' : 'pending';
      const coach = coachOf(cid, m.s || m.p, m.exp) || coachOf(cid, '2000-01-01', to) || '—';
      const t = (by[coach] = by[coach] || { renewed: 0, lost: 0, pending: 0 });
      t[out]++; tot[out]++;
    });
  }
  const rate = (t) => (t.renewed + t.lost ? Math.round(t.renewed / (t.renewed + t.lost) * 100) : null);
  return { total: { ...tot, rate: rate(tot) },
    coaches: Object.entries(by).map(([coach, t]) => ({ coach, ...t, rate: rate(t) })).sort((a, b) => (b.renewed + b.lost) - (a.renewed + a.lost)),
    rule: 'rate = продлили ÷ (продлили + не продлили); «ещё решают» — закончились меньше 7 дней назад' };
}

/* Скидка ровно 100 (зачёт пробного) без пробного: счёт пробного в in2 с 01.07 или пробное в Джарвисе (посещение/таблица). */
async function adminErrors(from, to) {
  const body = (a, b) => ({ method: 'POST', body: { fromDate: a, toDate: b } });
  const [early, season, list, trials] = await Promise.all([
    in2.call('/reports/sales', body('2026-07-01', '2026-08-31')),
    in2.call('/reports/sales', body('2026-09-01', to)),
    in2.call('/customers/list', { method: 'POST', body: {} }),
    bridge('trials_range', { dateFrom: '2026-08-01', dateTo: to }),
  ]);
  const iso = (d) => { const v = String(d || ''); return v.includes('/') ? v.slice(0, 10).split('/').reverse().join('-') : v.slice(0, 10); };
  const sales = [...(early.transactions || []), ...(season.transactions || [])];
  const trialInv = new Set(sales.filter((t) => /trial/i.test(t.itemName || '')).map((t) => t.clientId));
  const cs = new Map((Array.isArray(list) ? list : []).map((c) => [c.id, c]));
  const tr = [...(trials.items || []), ...(trials.others || []), ...(trials.excluded || [])];
  const d8 = (p) => String(p || '').replace(/\D/g, '').slice(-8);
  const nm = (s) => String(s || '').toLowerCase().replace(/[^a-zа-яё؀-ۿ ]/g, '').trim();
  const rows = sales.filter((t) => iso(t.date) >= from && iso(t.date) <= to && Number(t.originalAmount) - Number(t.amount) === 100
    && !/trial/i.test(t.itemName || '') && !trialInv.has(t.clientId)).filter((t) => {
    const c = cs.get(t.clientId) || {}, par = cs.get(c.parentId) || {}, phone = c.phoneNumber || par.phoneNumber || '';
    return !(tr.find((x) => x.id === t.clientId) || tr.find((x) => d8(x.phone) && d8(x.phone) === d8(phone) && nm(x.name).split(' ')[0] === nm(t.clientName).split(' ')[0])
      || tr.find((x) => nm(x.name) === nm(t.clientName)));
  });
  const byWho = {};
  for (const r of rows) byWho[r.name || '?'] = (byWho[r.name || '?'] || 0) + 1;
  return { count: rows.length, lostQar: rows.length * 100, byWho, list: rows.map((r) => ({ date: iso(r.date), child: r.clientName, item: r.itemName, by: r.name })) };
}

/* Ответ на заявку: от появления лида (ночь — с 9:00) до кнопки «✅ Ответил». */
function responseTimes(from, to) {
  const db = require('better-sqlite3')(path.join(__dirname, '../../data/acrogym.db'), { readonly: true });
  const ts = (s) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  const rows = db.prepare('SELECT created_at, responded_at FROM leads WHERE created_at >= ? AND created_at < ? AND responded_at IS NOT NULL')
    .all(from, dayjs(to).add(1, 'day').format('YYYY-MM-DD'));
  const total = db.prepare('SELECT COUNT(*) n FROM leads WHERE created_at >= ? AND created_at < ?').get(from, dayjs(to).add(1, 'day').format('YYYY-MM-DD')).n;
  db.close();
  const mins = rows.map((r) => (ts(r.responded_at) - effectiveNotifiedMs(ts(r.created_at))) / 60000).map((m) => Math.max(0, m)).sort((a, b) => a - b);
  if (!mins.length) return { leads: total, responded: 0 };
  return { leads: total, responded: mins.length, medianMin: Math.round(mins[mins.length >> 1]),
    within30: mins.filter((m) => m <= 30).length, within60: mins.filter((m) => m <= 60).length,
    within30Pct: Math.round(mins.filter((m) => m <= 30).length / mins.length * 100),
    rule: 'рабочее время с 9:00; момент ответа — нажатие «✅ Ответил» в карточке лида (если админ ответил в WhatsApp и не нажал — время завышено)' };
}

/* Период: 'ГГГГ-ММ' (месяц) или {from, to} (онлайн-дашборд Джарвиса, любые даты).
   Прошлый период: для месяца — прошлый месяц; с 1-го числа — те же дни прошлого месяца; иначе — столько же дней перед. */
function period(arg) {
  if (typeof arg === 'string' && /^\d{4}-\d{2}$/.test(arg)) arg = { from: arg + '-01', to: dayjs(arg + '-01').endOf('month').format('YYYY-MM-DD') };
  const a = dayjs(arg.from), b = dayjs(arg.to), days = b.diff(a, 'day') + 1;
  const whole = a.date() === 1 && b.isSame(a.endOf('month'), 'day');
  let pa, pb;
  if (a.date() === 1 && a.isSame(b, 'month')) {
    pa = a.subtract(1, 'month');
    pb = whole ? pa.endOf('month') : pa.add(days - 1, 'day');
    if (pb.month() !== pa.month()) pb = pa.endOf('month'); /* 1–31 марта против февраля: не вылезать в следующий месяц */
  }
  else { pa = a.subtract(days, 'day'); pb = a.subtract(1, 'day'); }
  const f = (d) => d.format('YYYY-MM-DD');
  return { ym: whole ? a.format('YYYY-MM') : null, from: f(a), to: f(b), prevFrom: f(pa), prevTo: f(pb), days };
}

async function collect(arg) {
  const { ym, from, to, prevFrom: pFrom, prevTo: pTo, days } = period(arg);
  const today = dayjs().format('YYYY-MM-DD');
  const cur = await buildMonthlyReport({ lang: 'ru', from, to, prevFrom: pFrom, prevTo: pTo, dryRun: true });
  const prev = await buildMonthlyReport({ lang: 'ru', from: pFrom, to: pTo, dryRun: true });
  const [ue, progress, renCoach, admin, prevRen, prevAdmin, staff] = await Promise.all([
    soft(bridge('unit_economics', { dateFrom: from, dateTo: to, mode: 'fact', compare: true })),
    soft(bridge('progress_dash', { month: to.slice(0, 7) })),
    soft(coachRenewals(from, to, today)),
    soft(adminErrors(from, to)),
    soft(coachRenewals(pFrom, pTo, today)),
    soft(adminErrors(pFrom, pTo)),
    soft(in2.payrollPeriod(from, to)),
  ]);
  const gym = cur.sections.gym || {};
  const kris = (gym.coaches || []).find((c) => /kristina/i.test(c.name));
  const read = (f, n) => { try { return fs.readFileSync(f, 'utf8').slice(0, n); } catch { return ''; } };
  return {
    ym, from, to, prevFrom: pFrom, prevTo: pTo, days, generatedAt: new Date().toISOString(),
    month: cur.sections, prevMonth: prev.sections,
    pnl: ue.pnl ? { earned: ue.pnl.revenue, payrollPerClass: ue.pnl.coaches.total, fixed: ue.pnl.fixed, oneoffs: ue.pnl.oneoffs,
      profitAfterOneoffs: ue.pnl.profitAfterOneoffs, kristinaNotCost: kris ? kris.pay : null,
      note: 'заработано = выручка с термом, разнесённым по дням действия пакета; Кристина в расходах движка не считается (not_cost) — её оплата показана отдельно' } : ue,
    unit: ue.pnl ? { occupancy: ue.occupancy, cac: ue.cac, funnel: ue.funnel, retention: ue.retention, breakEven: ue.breakEven,
      perKid: ue.perKid, arpu: ue.arpu, kids: ue.kids, prev: ue.prev } : null,
    progress: progress.stats ? { totals: progress.stats.totals, coaches: (progress.stats.coaches || []).map(({ list, ...c }) => c),
      note: 'инструмент прогресса запущен 24.10' } : progress,
    coachRenewals: renCoach, prevCoachRenewals: prevRen,
    adminErrors: admin, prevAdminErrors: prevAdmin ? { count: prevAdmin.count, byWho: prevAdmin.byWho } : null,
    marketPay: MARKET_PAY,
    payrollStaff: Array.isArray(staff) ? staff.map((t) => ({ name: t.name, salary: t.salary, earnings: t.earnings, classes: t.classes.length, privates: t.privates })) : staff,
    response: responseTimes(from, to), prevResponse: responseTimes(pFrom, pTo),
    kristinaShare: kris && gym.kids ? Math.round(kris.kids / gym.kids * 100) : null,
    goals: JSON.parse(read(path.join(__dirname, 'goals.json'), 1e5) || '{}'),
    strategy: read(path.join(__dirname, 'strategy.md'), 2e4),
    competitors: read(path.join(__dirname, '../../data/competitor-brief.md'), 6000),
  };
}

module.exports = { collect, period, coachRenewals, adminErrors, responseTimes };

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '../../.env') });
  /* node collect.js [ГГГГ-ММ | ГГГГ-ММ-ДД:ГГГГ-ММ-ДД] [файл] — онлайн-дашборд Джарвиса зовёт с диапазоном и файлом кэша */
  const a = process.argv[2] || dayjs().subtract(1, 'month').format('YYYY-MM');
  const ym = a.includes(':') ? null : a;
  collect(ym || { from: a.split(':')[0], to: a.split(':')[1] }).then((d) => {
    const out = process.argv[3] || path.join(__dirname, '../../docs/board', ym, 'facts.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(d, null, 1));
    console.log(out, JSON.stringify({ renewals: d.coachRenewals.total, admin: d.adminErrors.count, response: d.response, kristina: d.kristinaShare, progress: d.progress.totals }));
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}
