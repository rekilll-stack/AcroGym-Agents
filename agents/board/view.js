'use strict';

/**
 * agents/board/view.js — как выглядит «совет директоров»: один HTML-дашборд и для PDF (A4), и для экрана Джарвиса.
 * 01.11 владелец: «хочется больше красивого дизайна, дэшбордов и графиков — тяжело читать чисто текст».
 * Графики — HTML-полосы и inline SVG без библиотек и без скриптов: печатаются в PDF и рисуются в WebView (iframe sandbox).
 * Цвета данных — бренд (navy, orange — внимание); статусы (по плану / риск / отстаём / база) — всегда значок + подпись.
 */

const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');

const ROOT = path.join(__dirname, '../..');

const STRATEGY = [
  ['y1', 'Год 1: доказать устойчивость модели', 'Year 1: prove the model is sustainable'],
  ['y3', '3 года: основа сети и франшизы', '3 years: groundwork for a network and franchise'],
  ['y5', '5 лет: производство через проверенный спрос', '5 years: equipment production through proven demand'],
  ['c1', 'Опыт Кристины → знания команды', 'Kristina’s know-how → team knowledge'],
  ['c2', 'Понятное обещание семье', 'A clear promise to families'],
  ['c3', 'Реальная экономика центра', 'The real economics of the centre'],
  ['c4', 'Удержание как управляемый процесс', 'Retention as a managed process'],
  ['c5', 'Ответственность и полномочия сотрудников', 'Staff responsibility and authority'],
  ['c6', 'Самостоятельность команды на практике', 'Team independence in practice'],
  ['p1', '90 дней: достоверная картина финансов, загрузки и клиентов', '90 days: a reliable picture of money, load and clients'],
  ['p2', '90 дней: одно направление для передачи методики Кристины', '90 days: one area to hand over Kristina’s method'],
  ['p3', '90 дней: ответственность админов за этапы общения с семьёй', '90 days: admins own each stage of family communication'],
  ['p4', '90 дней: обратная связь родителям о прогрессе', '90 days: progress feedback to parents'],
  ['p5', '90 дней: еженедельное время на развитие', '90 days: weekly time for development'],
];
const STRATEGY_GROUPS = [['y', 'Горизонты 1, 3 и 5 лет', 'Horizons: 1, 3 and 5 years'], ['c', 'Что нужно изменить', 'What needs to change'], ['p', 'Приоритеты на 90 дней', '90-day priorities']];

const ROLES = [
  ['cfo', 'Финансовый директор', 'CFO', 'прибыль «заработано» против кассы, постоянные и разовые расходы, квартальная аренда 81 750 в ноябре (деньги на счету), цена занятия, загрузка и точка безубыточности, прибыль с полной арендой и рыночной оплатой владельца/Кристины'],
  ['accountant', 'Главный бухгалтер', 'Chief accountant', 'точность учёта: ЗП по Payroll in2 против правил (оклады, ставки на занятиях, персоналки 40 %), просрочка клиентов, обязательства по уже оплаченным занятиям (термы вперёд), разовые платежи, расхождения между источниками'],
  ['head_coach', 'Главный тренер', 'Head coach', 'нагрузка и дети по тренерам, доля детей у Кристины, продления по тренерам, пустые занятия, отчёты о прогрессе детей родителям, передача методики Кристины другим тренерам'],
  ['marketing', 'Директор по маркетингу', 'Marketing director', 'заявки и источники (Meta против сайта), почему заявки Meta редко доходят до in2, цена клиента, бюджет 6 000/мес (реклама 3 000 + SMM 3 000), контент и позиционирование против конкурентов'],
  ['sales', 'Директор по продажам и сервису', 'Sales & service director', 'путь семьи: заявка → пробное → покупка → продление; скорость ответа; работа админов (Michael, Bruhan), ошибки (скидка 100 без пробного), причины отказа в чек-листе (сбор начат 31.10), напоминания о продлении'],
  ['competitors', 'Аналитик конкурентов', 'Competitor analyst', 'рынок детской гимнастики и игровых залов в Дохе по брифу конкурентов, чем мы сильнее и слабее, что конкуренты делают в сезоне (лагеря, акции), какие ходы нам выгодны'],
  ['voice', 'Голос клиента', 'Voice of the customer', 'что видит и чувствует семья: почему продлевают и почему уходят (по данным продлений, каникулы 25–29.10), прогресс ребёнка, общение с админами, обещание семье из стратегии'],
  ['growth', 'Директор по развитию', 'Development director', 'федерация/сотрудничество с Qatar Gymnastics Federation, соревнования, вторая площадка, франшиза, оборудование: какие условия должны выполниться до каждого шага и что делать в ближайшие 90 дней'],
];
const ROLE_ICON = { director: '🏛', cfo: '💰', accountant: '🧾', head_coach: '🤸', marketing: '📣', sales: '🤝', competitors: '🔭', voice: '💬', growth: '🚀' };
const ROLE_NAMES = Object.fromEntries([['director', 'Директор', 'Director'], ...ROLES].map(([id, ru, en]) => [id, { ru, en }]));
const KPI_NAMES = Object.fromEntries((JSON.parse(fs.readFileSync(path.join(__dirname, 'goals.json'), 'utf8')).goals || []).map((g) => [g.id, g]));
/* куда смотрит цель: меньше — лучше (доля Кристины, ошибки, время ответа) */
const LOWER_BETTER = new Set(['kristina_share', 'admin_errors', 'response']);

const GLOSSARY = [
  ['Продление', 'Семья купила новый месячный абонемент или терм после окончания прежнего. Доля = продлили ÷ (продлили + не продлили).', 'Renewal', 'A family bought a new monthly package or term after the previous one ended. Rate = renewed ÷ (renewed + did not renew).'],
  ['Ещё решают', 'Абонемент закончился меньше 7 дней назад, нового пока нет.', 'Still deciding', 'The package ended less than 7 days ago and there is no new one yet.'],
  ['Пробное → покупка', 'Доля детей, которые после пробного занятия купили абонемент.', 'Trial → purchase', 'Share of kids who bought a package after a trial class.'],
  ['Заявка → пробное', 'Доля заявок месяца (Meta, сайт), дошедших до посещённого пробного.', 'Lead → trial', 'Share of the month’s leads (Meta, website) that reached an attended trial.'],
  ['Загрузка зала', 'Сколько мест на занятиях занято детьми: дети ÷ места.', 'Capacity used', 'How many class places were taken: kids ÷ places.'],
  ['Заработано', 'Выручка месяца, где терм разнесён по дням его действия. Не путать с «получено» — деньгами в кассе.', 'Earned', 'Revenue for the month with each term spread over the days it covers. Not the same as cash received.'],
  ['Просрочка', 'Счета, срок оплаты которых наступил, а денег нет.', 'Overdue', 'Invoices that are due but unpaid.'],
  ['Payroll in2', 'Расчёт зарплаты в in2: оклады + оплата за занятия по ставкам; дети на занятии — те, кого засчитал in2.', 'in2 Payroll', 'The pay calculation in in2: salaries plus per-class pay; kids per class are those in2 counted.'],
  ['п.п.', 'Процентный пункт: 48 % → 58 % — это +10 п.п.', 'pp', 'Percentage point: 48% → 58% is +10 pp.'],
  ['Медиана', 'Середина ряда: половина значений меньше, половина больше.', 'Median', 'The middle value: half are lower, half are higher.'],
  ['Прибыль с полной оплатой', 'Заработано минус все расходы, полная аренда, оплата Кристины и оценка оплаты управляющего — экономика «как у франшизы».', 'Profit with full pay', 'Earned minus all costs, full rent, Kristina’s pay and an estimated manager salary — the economics a franchisee would see.'],
];

const CSS = `
:root{--bg:#fff;--card:#f4f6fb;--ink:#1d2233;--ink2:#545b75;--muted:#8a90a6;--line:#e3e6f0;--track:#e6e9f3;
 --navy:#28347F;--navy2:#8f9bd4;--orange:#F37021;--grey:#c3c8d6;--head:#28347F;
 --good:#2b8a3e;--goodBg:#e6f4ea;--warn:#b25e00;--warnBg:#fff1db;--bad:#c92a2a;--badBg:#fde8e8;--base:#3b5bdb;--baseBg:#e8edff;--noneBg:#eef0f4}
:root[data-theme=dark]{--bg:#0d1226;--card:#161d3a;--ink:#eef1fb;--ink2:#b7bfdc;--muted:#8a93b5;--line:#283160;--track:#262f58;
 --navy:#8c9cff;--navy2:#4a5596;--orange:#ff8a3d;--grey:#868ba3;--head:#c9d1ff;
 --good:#69db7c;--goodBg:#16341f;--warn:#ffc069;--warnBg:#3a2a10;--bad:#ff8787;--badBg:#3d1818;--base:#91a7ff;--baseBg:#1d2650;--noneBg:#22294a}
*{box-sizing:border-box}html,body{background:var(--bg)}
body{font-family:M,Montserrat,system-ui,sans-serif;color:var(--ink);margin:0;font-size:13px;line-height:1.45;padding:12px}
h1{color:var(--head);font-size:21px;margin:2px 0 8px;font-weight:800;line-height:1.2}
h2{color:var(--head);font-size:15px;margin:22px 0 8px;font-weight:800;display:flex;align-items:center;gap:8px}
h2 small{font-weight:600;color:var(--muted);font-size:11px;margin-left:auto}
h3{color:var(--head);font-size:13px;margin:12px 0 6px;font-weight:700}
header{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid var(--orange);padding-bottom:7px;margin-bottom:10px}
header img{height:30px}header div{color:var(--ink2);text-align:right;font-size:11px}
.verdict{background:var(--card);border-left:4px solid var(--orange);padding:10px 13px;border-radius:10px}
.grid{display:grid;gap:9px;grid-template-columns:repeat(auto-fill,minmax(205px,1fr))}
.grid.two{grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
.card{background:var(--card);border-radius:12px;padding:11px 13px;break-inside:avoid}
.hero{display:grid;gap:9px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));margin:10px 0}
.tile{background:var(--card);border-radius:12px;padding:10px 12px;break-inside:avoid}
.tile b{display:block;font-size:21px;color:var(--head);font-weight:800;line-height:1.15;font-variant-numeric:tabular-nums}
.tile span{color:var(--ink2);font-size:11.5px}.tile i{display:block;font-style:normal;font-size:11px;color:var(--muted);margin-top:3px}
.chip{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:1px 8px;font-size:10.5px;font-weight:700;white-space:nowrap}
.st-green{background:var(--goodBg);color:var(--good)}.st-yellow{background:var(--warnBg);color:var(--warn)}.st-red{background:var(--badBg);color:var(--bad)}
.st-base{background:var(--baseBg);color:var(--base)}.st-grey{background:var(--noneBg);color:var(--muted)}
.tag{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 7px;font-size:10.5px;color:var(--ink2);margin:3px 4px 0 0;white-space:nowrap}
.kpi .kh{display:flex;justify-content:space-between;gap:6px;align-items:flex-start;font-weight:700;font-size:12px;min-height:32px}
.kpi .kv{font-size:24px;font-weight:800;color:var(--head);margin:2px 0 0;font-variant-numeric:tabular-nums}
.kpi .kv small{font-size:11px;color:var(--muted);font-weight:600;margin-left:6px}
.kpi .kd{font-size:11px;color:var(--ink2);margin-top:4px}.kpi .kc{font-size:11.5px;margin-top:6px;border-top:1px solid var(--line);padding-top:6px}
.bul{position:relative;height:22px;margin:6px 0 0}.bul .tr{position:absolute;left:0;right:0;top:7px;height:9px;border-radius:5px;background:var(--track)}
.bul .fl{position:absolute;left:0;top:7px;height:9px;border-radius:5px;background:var(--navy);min-width:3px}
.bul .tg{position:absolute;top:2px;width:3px;height:19px;margin-left:-1.5px;background:var(--ink);border-radius:2px}
.bul .pv{position:absolute;top:4px;width:2px;height:15px;margin-left:-1px;background:var(--muted);opacity:.8}
.bul-s{display:flex;justify-content:space-between;font-size:10px;color:var(--muted)}
.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:var(--ink2);margin:4px 0 8px}
.legend i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.legend i.ln{width:3px;height:13px;border-radius:1px}
.rows{display:grid;grid-template-columns:minmax(80px,32%) 1fr auto;gap:7px 9px;align-items:center;font-size:12px}.row{display:contents}
.row .nm{font-weight:600;line-height:1.25;min-width:0}.row .nm small{display:block;font-weight:500;color:var(--muted);font-size:10.5px}
.row .vl{font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right;font-size:11.5px}.row .vl small{color:var(--muted)}
.bar{position:relative;height:14px;border-radius:4px;background:var(--track)}.bar i{position:absolute;top:0;bottom:0;border-radius:4px;background:var(--navy);min-width:2px}
.bar i.o{background:var(--orange)}.bar i.p{background:var(--navy2)}.bar i.g{background:var(--good)}
.bar2{display:grid;gap:2px}.bar2 .bar{height:8px}
.stack{display:flex;gap:2px;height:22px;border-radius:6px;overflow:hidden;margin:6px 0 4px}.stack i{display:block;height:100%;min-width:3px}
.c-navy{background:var(--navy)}.c-orange{background:var(--orange)}.c-light{background:var(--navy2)}.c-grey{background:var(--grey)}
.plan{display:grid;gap:9px}.plan .card{display:grid;grid-template-columns:34px 1fr;gap:10px}
.plan .n{width:30px;height:30px;border-radius:50%;background:var(--orange);color:#fff;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:15px}
.plan .w{font-weight:700}.plan .y{color:var(--ink2);font-size:12px;margin-top:3px}.plan .h{font-size:11.5px;margin-top:5px}.plan .h b{color:var(--head)}
.strat{display:grid;grid-template-columns:1fr auto;gap:4px 10px;padding:8px 0;border-bottom:1px solid var(--line);break-inside:avoid}
.strat:last-child{border-bottom:0}.strat .t{font-weight:700;font-size:12px}.strat .c{grid-column:1/-1;font-size:11.5px;color:var(--ink2)}
.role{margin-top:12px;break-inside:avoid-page}.role .rh{display:flex;align-items:center;gap:8px;font-weight:800;color:var(--head);font-size:14px}
.role .rh .ic{font-size:18px}.role .sum{margin:5px 0 4px;font-size:12.5px}
.role ul{margin:4px 0 8px 16px;padding:0;font-size:11.5px;color:var(--ink2)}.role li{margin:2px 0}
.adv .t{font-weight:700;font-size:12.5px}.adv .w{font-size:12px;margin-top:3px}.adv .e{font-size:11.5px;margin-top:5px;color:var(--good)}
.note{color:var(--ink2);font-size:11px;margin-top:6px}
.cap{font-size:11px;color:var(--muted);margin-top:4px}
svg text{font-family:M,Montserrat,system-ui,sans-serif}
svg .ax{fill:var(--muted);font-size:10px}svg .gl{stroke:var(--line);stroke-width:1}svg .ln{fill:none;stroke:var(--navy);stroke-width:2.2;stroke-linejoin:round}
svg .ln2{fill:none;stroke:var(--grey);stroke-width:1.6;stroke-dasharray:4 3}svg .ar{fill:var(--navy);opacity:.12}svg .lb{fill:var(--ink);font-size:10.5px;font-weight:700}
svg .dt{fill:var(--navy);stroke:var(--card);stroke-width:2}
.gl-t td{padding:6px 4px;border-bottom:1px solid var(--line);vertical-align:top;font-size:12px}.gl-t{border-collapse:collapse;width:100%}
.pb{break-before:page}
@media print{body{font-size:10px;padding:0}.pg{padding:0}h1{font-size:19px}.tile b{font-size:18px}.kpi .kv{font-size:20px}
 .grid{grid-template-columns:repeat(3,1fr)}.grid.two{grid-template-columns:repeat(2,1fr)}.hero{grid-template-columns:repeat(4,1fr)}
 .row,.plan .y,.strat .t,.adv .t,.role .sum{font-size:10.5px}.adv .w,.kpi .kc,.strat .c,.role ul,.adv .e,.plan .h{font-size:9.6px}}
`;

function fmt(lang) {
  const ru = lang === 'ru';
  const L = (o) => (o && typeof o === 'object' ? o[lang] || o.ru || '' : o || '');
  const T = (r, e) => (ru ? r : e);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const num = (n) => (n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString(ru ? 'ru-RU' : 'en-US').replace(/[\s ]/g, ru ? ' ' : ','));
  const dec = (n, d = 1) => (n == null ? '—' : String(Math.round(n * 10 ** d) / 10 ** d).replace('.', ru ? ',' : '.'));
  const val = (x, v) => (v == null ? '—' : x.unit === '%' ? `${dec(v)} %` : x.unit === ' QAR' ? num(v) : x.unit === ' мин' ? `${v} ${T('мин', 'min')}` : String(v));
  const dt = (d) => (d ? dayjs(d).format(ru ? 'DD.MM' : 'D MMM') : '');
  const SL = { green: ['✓', T('по плану', 'on track')], yellow: ['!', T('риск', 'at risk')], red: ['✕', T('отстаём', 'behind')], grey: ['–', T('нет данных', 'no data')], base: ['◆', T('база', 'baseline')] };
  const chip = (s) => { const [ic, t] = SL[s] || SL.grey; return `<span class="chip st-${SL[s] ? s : 'grey'}">${ic} ${esc(t)}</span>`; };
  const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
  return { ru, L, T, esc, num, dec, val, dt, SL, chip, pct };
}

/* оплата управляющего — месячная оценка; за период короче месяца — пропорционально дням */
const mgrPay = (f) => Math.round(((f.marketPay || {}).manager || 0) * (f.days ? Math.min(1, f.days / 30.4) : 1));

// ─── Цели года: значение, прошлый месяц, светофор — детерминированно ───
const pct = (a, b) => (b ? Math.round(a / b * 100) : null);
const bi = (ru, en = ru) => ({ ru, en });
function kpis(f) {
  const M = f.month, P = f.prevMonth, R = f.coachRenewals || {}, PR = f.prevCoachRenewals || {};
  const tb = (s) => s && s.leads && s.leads.trials ? pct(s.leads.trials.bought, s.leads.trials.total) : null;
  const lt = (s) => s && s.leads && s.leads.funnel && s.leads.total ? Math.round(s.leads.funnel.trials / s.leads.total * 1000) / 10 : null;
  const share = (s) => { const g = s && s.gym; const k = g && (g.coaches || []).find((c) => /kristina/i.test(c.name)); return k && g.kids ? pct(k.kids, g.kids) : null; };
  const others = (r) => { const o = (r.coaches || []).filter((c) => !/kristina/i.test(c.coach) && c.coach !== '—');
    const rn = o.reduce((s, c) => s + c.renewed, 0), ls = o.reduce((s, c) => s + c.lost, 0); return { rate: pct(rn, rn + ls), list: o }; };
  const kp = (s) => { const g = s && s.gym; const k = g && (g.coaches || []).find((c) => /kristina/i.test(c.name)); return k ? k.pay : 0; };
  const pnl = f.pnl || {}, mgr = mgrPay(f);
  const profit = pnl.earned != null ? pnl.earned - pnl.payrollPerClass - pnl.fixed.total - pnl.oneoffs.total - (pnl.kristinaNotCost || 0) - mgr : null;
  const pp = f.unit && f.unit.prev && f.unit.prev.pnl ? f.unit.prev.pnl.profit - kp(P) - mgr : null;
  const resp = f.response || {}, presp = f.prevResponse || {};
  const oth = others(R), poth = others(PR);
  const st = (v, green, yellow, lower) => (v == null ? 'grey' : lower ? (v <= green ? 'green' : v <= yellow ? 'yellow' : 'red') : (v >= green ? 'green' : v >= yellow ? 'yellow' : 'red'));
  /* «+10 п.п. к базе»: база — октябрь 2026 (goals.json baseValue); в сам базовый месяц статус «база», дальше — против базы и цели */
  const BASE = (id) => KPI_NAMES[id] || {};
  const tgtB = (id, v) => (BASE(id).baseValue != null ? Math.round((BASE(id).baseValue + 10) * 10) / 10 : v != null ? Math.round((v + 10) * 10) / 10 : null);
  const baseSt = (id, v) => (v == null ? 'grey' : BASE(id).baseValue == null || f.ym === BASE(id).baseYm ? 'base' : v >= tgtB(id, v) ? 'green' : v >= BASE(id).baseValue ? 'yellow' : 'red');
  return [
    { id: 'renewal', value: R.total && R.total.rate, prev: PR.total && PR.total.rate, unit: '%', target: '85 %', status: st(R.total && R.total.rate, 85, 77),
      detail: R.total ? bi(`${R.total.renewed} / ${R.total.renewed + R.total.lost} · ещё решают ${R.total.pending}`, `${R.total.renewed} / ${R.total.renewed + R.total.lost} · still deciding ${R.total.pending}`) : null },
    { id: 'trial_buy', value: tb(M), prev: tb(P), unit: '%', target: tgtB('trial_buy', tb(M)) != null ? `${tgtB('trial_buy', tb(M))} %` : '+10 п.п.', status: baseSt('trial_buy', tb(M)),
      detail: M.leads.trials ? bi(`${M.leads.trials.bought} / ${M.leads.trials.total}`) : null },
    { id: 'lead_trial', value: lt(M), prev: lt(P), unit: '%', target: tgtB('lead_trial', lt(M)) != null ? `${tgtB('lead_trial', lt(M))} %` : '+10 п.п.', status: baseSt('lead_trial', lt(M)),
      detail: M.leads.funnel ? bi(`${M.leads.funnel.trials} / ${M.leads.total}`) : null },
    { id: 'kristina_share', value: share(M), prev: share(P), unit: '%', target: '< 50 %', status: st(share(M), 50, 70, true) },
    { id: 'coach_renewal', value: oth.rate, prev: poth.rate, unit: '%', target: '≥ 75 %', status: st(oth.rate, 75, 65),
      detail: bi(oth.list.filter((c) => c.renewed + c.lost >= 5).map((c) => `${c.coach.split(' ')[0]} ${c.rate}%`).join(', ')) },
    { id: 'progress', value: f.progress && f.progress.totals ? pct(f.progress.totals.sent, f.progress.totals.kids) : null, prev: null, unit: '%', target: '100 %',
      status: st(f.progress && f.progress.totals ? pct(f.progress.totals.sent, f.progress.totals.kids) : null, 100, 50),
      detail: f.progress && f.progress.totals ? bi(`отправлено ${f.progress.totals.sent} из ${f.progress.totals.kids} · готово к отправке ${f.progress.totals.ready}`, `sent ${f.progress.totals.sent} of ${f.progress.totals.kids} · ready to send ${f.progress.totals.ready}`) : null },
    { id: 'admin_errors', value: f.adminErrors && f.adminErrors.count, prev: f.prevAdminErrors && f.prevAdminErrors.count, unit: '', target: '0',
      status: st(f.adminErrors && f.adminErrors.count, 0, 2, true), detail: f.adminErrors ? bi(Object.entries(f.adminErrors.byWho || {}).map(([k, v]) => `${k} ${v}`).join(', ')) : null },
    { id: 'response', value: resp.medianMin, prev: presp.medianMin, unit: ' мин', target: '≤ 30 мин',
      status: resp.medianMin == null ? 'grey' : resp.medianMin <= 30 && resp.within30Pct >= 90 ? 'green' : resp.medianMin <= 30 ? 'yellow' : 'red',
      detail: resp.responded ? bi(`за 30 мин — ${resp.within30Pct}% заявок`, `within 30 min — ${resp.within30Pct}% of leads`) : null },
    { id: 'profit_full', value: profit, prev: pp, unit: ' QAR', target: '> 0', status: st(profit, 1, -1e12),
      detail: profit != null ? bi(`управляющий — оценка; прошлый ${f.ym ? 'месяц' : 'период'} без разовых расходов`, `manager pay is an estimate; the previous ${f.ym ? 'month' : 'period'} excludes one-off costs`) : null },
  ];
}

/* полоса «сейчас → цель»: заливка = значение, чёрная риска = цель, серая = прошлый месяц */
function bullet(x, F) {
  if (x.value == null) return '';
  const tgt = parseFloat(String(x.target).replace(',', '.').replace(/[^\d.-]/g, '')) || 0;
  const max = x.unit === '%' ? 100 : Math.max(x.value, x.prev || 0, tgt, x.id === 'response' ? 60 : 10) * 1.1;
  const p = (v) => Math.max(0, Math.min(100, v / max * 100));
  const fill = p(Math.max(0, x.value));
  return `<div class="bul" role="img" aria-label="${F.esc(`${F.val(x, x.value)} / ${x.target}`)}"><div class="tr"></div><div class="fl" style="width:${fill}%"></div>`
    + (x.prev != null && x.prev >= 0 ? `<div class="pv" style="left:${p(x.prev)}%"></div>` : '')
    + `<div class="tg" style="left:${p(tgt)}%"></div></div><div class="bul-s"><span>0</span><span>${F.T('цель', 'target')} ${F.esc(F.ru ? x.target.replace(/(\d)\.(\d)/, '$1,$2') : x.target.replace('мин', 'min').replace('п.п.', 'pp'))}</span></div>`;
}

/* строки-полосы: [{name, sub, v, label, cls, prev}] — одна шкала на всю группу */
function rows(list, F, { max } = {}) {
  const m = max || Math.max(1, ...list.map((r) => Math.max(r.v || 0, r.prev || 0)));
  return `<div class="rows">${list.map((r) => {
    const b = (v, cls) => `<div class="bar"><i class="${cls || ''}" style="left:0;width:${Math.max(0, v) / m * 100}%"></i></div>`;
    return `<div class="row"><div class="nm" title="${F.esc(r.name)}">${F.esc(r.name)}${r.sub ? `<small>${F.esc(r.sub)}</small>` : ''}</div>`
      + (r.prev != null ? `<div class="bar2">${b(r.prev, 'p')}${b(r.v, r.cls)}</div>` : b(r.v, r.cls))
      + `<div class="vl">${r.label != null ? r.label : F.num(r.v)}</div></div>`;
  }).join('')}</div>`;
}

/* доли целого одной полосой + легенда с числами: [{name, v, c: navy|orange|light|grey}] */
function stack(parts, F) {
  const tot = parts.reduce((s, x) => s + (x.v || 0), 0) || 1;
  return `<div class="stack" role="img" aria-label="${F.esc(parts.map((x) => `${x.name} ${x.v}`).join(', '))}">${parts.filter((x) => x.v > 0).map((x) => `<i class="c-${x.c}" style="flex:${x.v}" title="${F.esc(x.name)}: ${x.v}"></i>`).join('')}</div>`
    + `<div class="legend">${parts.map((x) => `<span><i class="c-${x.c}"></i>${F.esc(x.name)} <b>${F.num(x.v)}</b> · ${F.pct(x.v, tot)} %</span>`).join('')}</div>`;
}

/* дети по дням месяца: линия этого месяца + пунктир прошлого (по числу месяца) */
function dayLine(cur, prev, F) {
  const W = 380, H = 160, l = 30, r = 10, t = 16, b = 22, n = Math.max(cur.length, prev.length, 28);
  const max = Math.ceil(Math.max(10, ...cur.map((x) => x[1]), ...prev.map((x) => x[1])) / 20) * 20;
  const X = (i) => l + i / (n - 1) * (W - l - r), Y = (v) => t + (1 - v / max) * (H - t - b);
  const pts = (a) => a.map((x, i) => `${X(i).toFixed(1)},${Y(x[1]).toFixed(1)}`).join(' ');
  const grid = [0, max / 2, max].map((v) => `<line class="gl" x1="${l}" x2="${W - r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ax" x="${l - 5}" y="${Y(v) + 3}" text-anchor="end">${v}</text>`).join('');
  const xl = [1, 8, 15, 22, 29].filter((d) => d <= n).map((d) => `<text class="ax" x="${X(d - 1)}" y="${H - 6}" text-anchor="middle">${d}</text>`).join('');
  const top = cur.reduce((a, x, i) => (x[1] > a.v ? { v: x[1], i } : a), { v: -1, i: 0 });
  const area = cur.length ? `<polygon class="ar" points="${X(0)},${Y(0)} ${pts(cur)} ${X(cur.length - 1)},${Y(0)}"/>` : '';
  const dots = cur.map((x, i) => `<circle cx="${X(i)}" cy="${Y(x[1])}" r="7" fill="transparent"><title>${F.dt(x[0])}: ${x[1]}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${F.esc(F.T('Дети на занятиях по дням', 'Kids in classes by day'))}">${grid}${xl}${area}`
    + (prev.length ? `<polyline class="ln2" points="${pts(prev)}"/>` : '') + `<polyline class="ln" points="${pts(cur)}"/>`
    + `<circle class="dt" cx="${X(top.i)}" cy="${Y(top.v)}" r="4"/><text class="lb" x="${Math.min(X(top.i), W - 40)}" y="${Y(top.v) - 7}" text-anchor="middle">${top.v}</text>${dots}</svg>`;
}

/* водопад прибыли: заработано → минус статьи → прибыль; строки, общая шкала */
function waterfall(steps, F) {
  const max = Math.max(...steps.map((s) => s.v), 1);
  let run = 0;
  return `<div class="rows">${steps.map((s) => {
    let left, w, cls;
    if (s.kind === 'start') { left = 0; w = s.v; run = s.v; cls = ''; }
    else if (s.kind === 'end') { left = 0; w = Math.max(0, s.v); cls = s.v >= 0 ? 'g' : 'o'; }
    else { run -= s.v; left = Math.max(0, run); w = s.v; cls = 'o'; }
    return `<div class="row"><div class="nm" title="${F.esc(s.name)}">${F.esc(s.name)}${s.sub ? `<small>${F.esc(s.sub)}</small>` : ''}</div><div class="bar"><i class="${cls}" style="left:${left / max * 100}%;width:${w / max * 100}%"></i></div>`
      + `<div class="vl">${s.kind === 'cost' ? '−' : ''}${F.num(s.v)}</div></div>`;
  }).join('')}</div>`;
}

const delta = (cur, prev, F, { pct = true, unit = '' } = {}) => {
  if (cur == null || prev == null) return '';
  const vs = F.vs || F.T('к прошлому месяцу', 'vs last month');
  const d = cur - prev;
  const s = pct && prev ? `${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d / Math.abs(prev) * 100))} %` : `${d >= 0 ? '+' : '−'}${F.num(Math.abs(d))}${unit}`;
  return `<i>${d >= 0 ? '▲' : '▼'} ${s} ${vs}</i>`;
};
const tile = (v, label, extra = '') => `<div class="tile"><b>${v}</b><span>${label}</span>${extra}</div>`;

/**
 * html(f, k, roles, dir, lang, opts) — весь отчёт.
 * f — facts.json, k — цели (kpis), roles/dir — ответы ролей и директора.
 * opts.app — для экрана Джарвиса: шрифт и логотип из ресурсов приложения, тема opts.theme (light|dark).
 * Без ответов совета (dir = null) — онлайн-дашборд за любой период: только цифры и графики, без плана и советов.
 */
function html(f, k, roles, dir, lang, opts = {}) {
  const F = fmt(lang), { L, T, esc, num, chip } = F;
  const app = !!opts.app, theme = opts.theme === 'dark' ? 'dark' : 'light';
  const font = app
    ? `@font-face{font-family:M;src:url(montserrat-400.woff2)}@font-face{font-family:M;font-weight:600;src:url(montserrat-600.woff2)}@font-face{font-family:M;font-weight:700 800;src:url(montserrat-700.woff2)}`
    : ''; /* PDF: Montserrat установлен в системе со всеми начертаниями */
  const logo = app ? (theme === 'dark' ? 'logo-white.png' : 'logo.png') : `data:image/png;base64,${fs.readFileSync(path.join(__dirname, 'logo.png')).toString('base64')}`;
  const monthNames = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/i18n', lang + '.json'), 'utf8')).month_names;
  const mName = (d) => monthNames[String(dayjs(d).month() + 1)];
  const span = (a, b) => (a === b ? dayjs(a).format(F.ru ? 'DD.MM.YYYY' : 'D MMM YYYY') : `${F.dt(a)} – ${dayjs(b).format(F.ru ? 'DD.MM.YYYY' : 'D MMM YYYY')}`);
  const title = f.ym ? `${mName(f.from)} ${dayjs(f.from).year()}` : span(f.from, f.to);
  const curL = f.ym ? mName(f.from) : T('этот период', 'this period'), prevL = f.ym ? mName(f.prevFrom || dayjs(f.from).subtract(1, 'month')) : `${T('прошлый период', 'previous period')} (${span(f.prevFrom, f.prevTo)})`;
  F.vs = f.ym ? T('к прошлому месяцу', 'vs last month') : T('к прошлому периоду', 'vs previous period');
  const M = f.month || {}, P = f.prevMonth || {}, g = M.gym || {}, pg = P.gym || {}, pnl = f.pnl || {}, mgr = mgrPay(f);
  const kp = Object.fromEntries(k.map((x) => [x.id, x]));
  const prevEarned = f.unit && f.unit.prev && f.unit.prev.pnl ? f.unit.prev.pnl.revenue : null;
  /* в Джарвисе бренд уже в шапке приложения: там только подпись над первым разделом, без логотипа и повторов на «страницах» */
  const head = (right, first) => (app ? (first ? `<header><div style="text-align:left">${right}</div></header>` : '') : `<header><img src="${logo}" alt="AcroGym"><div>${right}</div></header>`);
  const sec = (ic, t, small) => `<h2><span>${ic}</span>${esc(t)}${small ? `<small>${esc(small)}</small>` : ''}</h2>`;
  const page = (inner, first) => `<div class="pg${first ? '' : ' pb'}">${inner}</div>`;

  /* ── 1. Главное ── */
  const st = { green: 0, yellow: 0, red: 0, base: 0, grey: 0 };
  k.forEach((x) => { st[x.status] = (st[x.status] || 0) + 1; });
  const goals = k.map((x) => `<div class="card kpi"><div class="kh"><span>${esc((KPI_NAMES[x.id] || {})[lang] || x.id)}</span>${chip(x.status)}</div>`
    + `<div class="kv">${x.unit === ' QAR' ? num(x.value) + ' <small style="margin:0">QAR</small>' : F.val(x, x.value)}${x.prev != null ? `<small>${T('было', 'was')} ${F.val(x, x.prev)}</small>` : ''}</div>`
    + `${x.id === 'profit_full' ? '' : bullet(x, F)}${x.detail && L(x.detail) ? `<div class="kd">${esc(L(x.detail))}</div>` : ''}`
    + `${dir && dir.kpiComments && L(dir.kpiComments[x.id]) ? `<div class="kc">${esc(L(dir.kpiComments[x.id]))}</div>` : ''}</div>`).join('');
  const at = dayjs(f.generatedAt || undefined).add(3, 'hour').toISOString().slice(0, 16).replace('T', ' '); /* время Дохи */
  const p1 = head(dir ? `${T('Совет директоров', 'Board of directors')}<br>${T('отчёт владельцу', 'report to the owner')} · ${esc(dayjs(f.generatedAt || undefined).format(F.ru ? 'DD.MM.YYYY' : 'D MMM YYYY'))}`
      : `${T('Онлайн-дашборд', 'Live dashboard')}<br>${T('данные на', 'data as of')} ${esc(at)}`, true)
    + `<h1>${dir ? T('Итоги месяца', 'Month in review') : T('Показатели', 'Key numbers')}: ${esc(title)}</h1>`
    + `<div class="hero">${tile(num(pnl.earned), T('заработано, QAR', 'earned, QAR'), delta(pnl.earned, prevEarned, F))}`
    + tile(num(kp.profit_full && kp.profit_full.value), T('прибыль с полной оплатой, QAR', 'profit with full pay, QAR'), delta(kp.profit_full && kp.profit_full.value, kp.profit_full && kp.profit_full.prev, F))
    + tile(num(g.activeKids), T('активных детей', 'active kids'), `<i>${T('безубыточность', 'break-even')} — ${num(f.unit && f.unit.breakEven && f.unit.breakEven.kids)}</i>`)
    + tile(kp.renewal && kp.renewal.value != null ? kp.renewal.value + ' %' : '—', T('продлили абонемент', 'renewed their package'), delta(kp.renewal && kp.renewal.value, kp.renewal && kp.renewal.prev, F, { pct: false, unit: F.ru ? ' п.п.' : ' pp' })) + `</div>`
    + (dir && L(dir.verdict) ? `<div class="verdict">${esc(L(dir.verdict))}</div>` : '')
    + sec('🎯', T('Цели года', 'Goals for the year'), [['green', '✓'], ['yellow', '!'], ['red', '✕'], ['base', '◆']].filter(([s]) => st[s]).map(([s, ic]) => `${ic} ${F.SL[s][1]} ${st[s]}`).join(' · '))
    + `<div class="legend"><span><i class="c-navy"></i>${T('сейчас', 'now')}</span><span><i class="ln" style="background:var(--ink)"></i>${T('цель', 'target')}</span><span><i class="ln" style="background:var(--muted)"></i>${esc(prevL)}</span></div>`
    + `<div class="grid">${goals}</div>`
    + `<div class="note">${T('Цифры и статусы посчитаны кодом из in2, Джарвиса и базы заявок, не моделью. «База» — этот месяц стал точкой отсчёта для цели.', 'Values and statuses are computed by code from in2, Jarvis and the leads database, not by the model. “Baseline” means this month is the starting point for the goal.')}</div>`;

  /* ── 2. План и стратегия ── */
  const plan = ((dir && dir.plan) || []).slice(0, 5).map((p, i) => `<div class="card"><div class="n">${i + 1}</div><div><div class="w">${esc(L(p.what))}</div>`
    + `${L(p.why) ? `<div class="y">${esc(L(p.why))}</div>` : ''}<div>${L(p.owner) ? `<span class="tag">👤 ${esc(L(p.owner))}</span>` : ''}${p.deadline ? `<span class="tag">📅 ${T('до', 'by')} ${esc(F.dt(p.deadline))}</span>` : ''}</div>`
    + `${L(p.metric) ? `<div class="h"><b>${T('Как поймём:', 'How we know:')}</b> ${esc(L(p.metric))}</div>` : ''}</div></div>`).join('');
  const sOf = (key) => ((dir && dir.strategy) || []).find((x) => x.key === key) || {};
  const sCount = { green: 0, yellow: 0, red: 0, grey: 0 };
  STRATEGY.forEach(([key]) => { const s = sOf(key).status || 'grey'; sCount[s in sCount ? s : 'grey']++; });
  const strat = STRATEGY_GROUPS.map(([pre, ru, en]) => `<div class="card"><h3 style="margin-top:0">${esc(F.ru ? ru : en)}</h3>`
    + STRATEGY.filter(([key]) => key[0] === pre).map(([key, r, e]) => { const s = sOf(key); return `<div class="strat"><div class="t">${esc(F.ru ? r : e)}</div>${chip(s.status || 'grey')}${L(s.comment) ? `<div class="c">${esc(L(s.comment))}</div>` : ''}</div>`; }).join('') + `</div>`).join('');
  const p2 = head(esc(title)) + sec('🧭', T('План директора на месяц', 'Director’s plan for the month')) + `<div class="plan">${plan}</div>`
    + sec('🗺', T('Стратегия развития: где мы', 'Development strategy: where we are'))
    + stack([{ name: F.SL.green[1], v: sCount.green, c: 'navy' }, { name: F.SL.yellow[1], v: sCount.yellow, c: 'light' }, { name: F.SL.red[1], v: sCount.red, c: 'orange' }, { name: F.SL.grey[1], v: sCount.grey, c: 'grey' }], F)
    + `<div class="grid two">${strat}</div>`;

  /* ── 3. Деньги и зал ── */
  const fixedItems = ((pnl.fixed && pnl.fixed.items) || []);
  const rent = fixedItems.filter((x) => /аренд|rent/i.test(x.name)).reduce((s, x) => s + x.amount, 0);
  const water = [
    { name: T('Заработано', 'Earned'), v: pnl.earned || 0, kind: 'start' },
    { name: T('Аренда', 'Rent'), v: rent, kind: 'cost' },
    { name: T('Остальные постоянные', 'Other fixed costs'), sub: T('оклады, маркетинг, сервисы', 'salaries, marketing, services'), v: (pnl.fixed ? pnl.fixed.total : 0) - rent, kind: 'cost' },
    { name: T('ЗП за занятия', 'Per-class pay'), v: pnl.payrollPerClass || 0, kind: 'cost' },
    { name: T('Разовые расходы', 'One-off costs'), v: pnl.oneoffs ? pnl.oneoffs.total : 0, kind: 'cost' },
    { name: T('Кристина', 'Kristina'), v: pnl.kristinaNotCost || 0, kind: 'cost' },
    { name: T('Управляющий', 'Manager'), sub: T('оценка', 'estimate'), v: mgr, kind: 'cost' },
    { name: T('Прибыль', 'Profit'), v: kp.profit_full ? kp.profit_full.value : 0, kind: 'end' },
  ].filter((s) => s.kind !== 'cost' || s.v > 0);
  const cash = rows([
    { name: T('Заработано', 'Earned'), v: pnl.earned, prev: prevEarned, label: `${num(pnl.earned)} <small>/ ${num(prevEarned)}</small>` },
    { name: T('Получено в кассу', 'Cash received'), v: g.received, prev: pg.received, label: `${num(g.received)} <small>/ ${num(pg.received)}</small>` },
    { name: T('Выставлено счетов', 'Invoiced'), v: g.invoiced, prev: pg.invoiced, label: `${num(g.invoiced)} <small>/ ${num(pg.invoiced)}</small>` },
  ], F);
  const coachRen = (name) => ((f.coachRenewals || {}).coaches || []).find((x) => x.coach === name) || {};
  const coaches = rows((g.coaches || []).map((c) => { const r = coachRen(c.name), dec = r.renewed + r.lost;
    return { name: c.name.split(' ')[0], sub: `${c.classes} ${T('зан.', 'cl.')} · ${F.dec(c.kids / c.classes)} ${T('в ср.', 'avg')} · ${dec >= 5 ? `${T('продления', 'renewals')} ${r.rate} %` : T('продлений мало', 'few renewals')}`,
      v: c.kids, cls: /kristina/i.test(c.name) ? 'o' : '', label: `${num(c.kids)} <small>· ${F.pct(c.kids, g.kids)} %</small>` }; }), F);
  const pay = rows((g.coaches || []).map((c) => ({ name: c.name.split(' ')[0], sub: c.salary ? T('оклад', 'salary') : T('за занятия', 'per class'), v: c.pay, label: num(c.pay) })), F);
  const p3 = head(esc(title)) + sec('💰', T('Деньги', 'Money'), 'QAR')
    + `<div class="hero">${tile(num(g.received), T('получено в кассу', 'cash received'), delta(g.received, pg.received, F))}${tile(num(g.invoiced), T('выставлено счетов', 'invoiced'), delta(g.invoiced, pg.invoiced, F))}`
    + tile(num(g.debt && g.debt.overdue), T('просрочка', 'overdue'), `<i>${g.debt ? `${g.debt.families} ${T('семей', 'families')}` : ''}</i>`) + tile(num(f.unit && f.unit.perKid && f.unit.perKid.revenue), T('выручка на ребёнка', 'revenue per kid'), delta(f.unit && f.unit.perKid && f.unit.perKid.revenue, f.unit && f.unit.prev && f.unit.prev.perKid && f.unit.prev.perKid.revenue, F)) + `</div>`
    + `<div class="grid two"><div class="card"><h3 style="margin-top:0">${T('Откуда прибыль с полной оплатой', 'How the profit with full pay adds up')}</h3>${waterfall(water, F)}<div class="cap">${T('Оплата управляющего — оценка по открытым данным, не факт.', 'The manager pay is an estimate from public data, not a fact.')}</div></div>`
    + `<div class="card"><h3 style="margin-top:0">${f.ym ? T('Этот месяц и прошлый', 'This month and last') : T('Этот период и прошлый', 'This period and the previous one')}</h3><div class="legend"><span><i class="c-light"></i>${esc(prevL)}</span><span><i class="c-navy"></i>${esc(curL)}</span></div>${cash}`
    + `<div class="cap">${T('Касса ниже «заработано», когда семьи заплатили за терм заранее — в сентябре.', 'Cash is below “earned” when families paid for the term in advance, in September.')}</div></div></div>`
    + sec('🤸', T('Зал', 'The gym'))
    + `<div class="hero">${tile(num(g.classes), T('занятий', 'classes'), delta(g.classes, pg.classes, F))}${tile(num(g.kids), T('детей на занятиях', 'kids in classes'), delta(g.kids, pg.kids, F))}`
    + tile((g.utilization != null ? g.utilization : '—') + ' %', T('загрузка зала', 'capacity used'), delta(g.utilization, pg.utilization, F, { pct: false, unit: F.ru ? ' п.п.' : ' pp' })) + tile(num(g.empty), T('пустых занятий', 'empty classes'), delta(g.empty, pg.empty, F, { pct: false })) + `</div>`
    + `<div class="grid two"><div class="card"><h3 style="margin-top:0">${T('Дети на занятиях по дням', 'Kids in classes by day')}</h3><div class="legend"><span><i class="ln" style="background:var(--navy)"></i>${esc(curL)}</span><span><i class="ln" style="background:var(--grey)"></i>${esc(prevL)}</span></div>${dayLine(g.visitsByDate || [], pg.visitsByDate || [], F)}</div>`
    + `<div class="card"><h3 style="margin-top:0">${T('Дети по тренерам', 'Kids by coach')}</h3>${coaches}<div class="cap">${T('Оранжевым — Кристина: цель года — меньше 50 % детей.', 'Orange is Kristina: the year’s goal is under 50% of kids.')}</div></div>`
    + `<div class="card"><h3 style="margin-top:0">${T('Зарплата тренеров по in2, QAR', 'Coach pay from in2, QAR')}</h3>${pay}</div></div>`;

  /* ── 4. Семьи: путь от заявки до продления ── */
  const fu = (M.leads && M.leads.funnel) || {}, tri = (M.leads && M.leads.trials) || {}, tt = (f.unit && f.unit.funnel && f.unit.funnel.trialsTotals) || {};
  const funnel = rows([
    { name: T('Заявки', 'Leads'), v: fu.leads || (M.leads && M.leads.total) },
    { name: T('Карточка в in2', 'in2 card'), v: fu.cards, label: `${num(fu.cards)} <small>· ${F.pct(fu.cards, fu.leads)} %</small>` },
    { name: T('Пришли на пробное', 'Came to a trial'), v: fu.trials, label: `${num(fu.trials)} <small>· ${F.pct(fu.trials, fu.cards)} %</small>` },
    { name: T('Купили', 'Bought'), v: fu.bought, cls: 'o', label: `${num(fu.bought)} <small>· ${F.pct(fu.bought, fu.trials)} %</small>` },
  ], F);
  const SRC = { meta_make: 'Meta', website_form: T('Сайт', 'Website') };
  const pSrc = Object.fromEntries(((P.leads && P.leads.sources) || []).map((s) => [s.source, s.cnt]));
  const sources = rows(((M.leads && M.leads.sources) || []).map((s) => ({ name: SRC[s.source] || s.source, v: s.cnt, prev: pSrc[s.source] || 0, label: `${num(s.cnt)} <small>/ ${num(pSrc[s.source] || 0)}</small>` })), F);
  const ren = (f.coachRenewals && f.coachRenewals.total) || {};
  const renByCoach = rows(((f.coachRenewals || {}).coaches || []).filter((c) => c.renewed + c.lost >= 5).map((c) => ({ name: c.coach.split(' ')[0], sub: `${c.renewed} / ${c.renewed + c.lost} · ${T('решают', 'deciding')} ${c.pending}`, v: c.rate, cls: c.rate >= 75 ? '' : 'o', label: c.rate + ' %' })), F, { max: 100 });
  const resp = f.response || {};
  const pr = (f.progress && f.progress.totals) || {};
  const ae = f.adminErrors || {}, pae = f.prevAdminErrors || {};
  const who = [...new Set([...Object.keys(ae.byWho || {}), ...Object.keys(pae.byWho || {})])];
  const p4 = head(esc(title)) + sec('👨‍👩‍👧', T('Семьи: от заявки до продления', 'Families: from lead to renewal'))
    + `<div class="grid two"><div class="card"><h3 style="margin-top:0">${T('Воронка заявок', 'Lead funnel')}</h3>${funnel}<div class="cap">${T('Процент — от предыдущего шага.', 'The percentage is of the previous step.')}</div></div>`
    + `<div class="card"><h3 style="margin-top:0">${T('Пробные в зале', 'Trials in the gym')} · ${num(tri.total)}</h3>${stack([{ name: T('купили в тот же день', 'bought the same day'), v: tt.boughtSameDay || 0, c: 'navy' }, { name: T('купили позже', 'bought later'), v: tt.boughtLater || 0, c: 'light' }, { name: T('не купили', 'did not buy'), v: tt.notBought || Math.max(0, (tri.total || 0) - (tri.bought || 0)), c: 'orange' }], F)}`
    + `<h3>${T('Заявки по источникам', 'Leads by source')}</h3><div class="legend"><span><i class="c-light"></i>${esc(prevL)}</span><span><i class="c-navy"></i>${esc(curL)}</span></div>${sources}</div>`
    + `<div class="card"><h3 style="margin-top:0">${f.ym ? T('Продления: абонементы, закончившиеся в месяце', 'Renewals: packages that ended this month') : T('Продления: абонементы, закончившиеся за период', 'Renewals: packages that ended in the period')}</h3>${stack([{ name: T('продлили', 'renewed'), v: ren.renewed || 0, c: 'navy' }, { name: T('ещё решают', 'still deciding'), v: ren.pending || 0, c: 'grey' }, { name: T('не продлили', 'did not renew'), v: ren.lost || 0, c: 'orange' }], F)}`
    + `<h3>${T('Продления по тренерам', 'Renewals by coach')}</h3>${renByCoach}<div class="cap">${T('Тренеры, у кого решилось 5 и больше абонементов. Цель — 75 %.', 'Coaches with 5 or more decided packages. The target is 75%.')}</div></div>`
    + `<div class="card"><h3 style="margin-top:0">${T('Скорость ответа на заявку', 'How fast we reply to a lead')} · ${T('медиана', 'median')} ${resp.medianMin != null ? resp.medianMin + ' ' + T('мин', 'min') : '—'}</h3>${stack([{ name: T('до 30 мин', 'up to 30 min'), v: resp.within30 || 0, c: 'navy' }, { name: T('30–60 мин', '30–60 min'), v: Math.max(0, (resp.within60 || 0) - (resp.within30 || 0)), c: 'light' }, { name: T('дольше часа', 'over an hour'), v: Math.max(0, (resp.responded || 0) - (resp.within60 || 0)), c: 'orange' }], F)}`
    + `<h3>${T('Отчёты о прогрессе родителям', 'Progress reports to parents')}</h3>${stack([{ name: T('отправлено', 'sent'), v: pr.sent || 0, c: 'navy' }, { name: T('готово, не отправлено', 'ready, not sent'), v: Math.max(0, (pr.ready || 0) - (pr.sent || 0)), c: 'orange' }, { name: T('начато', 'started'), v: pr.started || 0, c: 'light' }, { name: T('не заполнено', 'not filled'), v: pr.none || 0, c: 'grey' }], F)}`
    + `<h3>${T('Ошибки админов: скидка 100 без пробного', 'Admin errors: 100 discount with no trial')}</h3><div class="legend"><span><i class="c-light"></i>${esc(prevL)}</span><span><i class="c-orange"></i>${esc(curL)}</span></div>`
    + rows(who.map((w) => ({ name: w, v: (ae.byWho || {})[w] || 0, prev: (pae.byWho || {})[w] || 0, cls: 'o', label: `${(ae.byWho || {})[w] || 0} <small>/ ${(pae.byWho || {})[w] || 0}</small>` })), F) + `</div></div>`;

  /* ── 5. Советы членов совета ── */
  const EFF = { low: T('усилие низкое', 'low effort'), medium: T('усилие среднее', 'medium effort'), high: T('усилие высокое', 'high effort') };
  const advCard = (a) => `<div class="card adv"><div class="t">${esc(L(a.title))}</div><div class="w">${esc(L(a.what))}</div>${L(a.effect) ? `<div class="e">↗ ${esc(L(a.effect))}</div>` : ''}`
    + `<div>${a.effort ? `<span class="tag">⚙︎ ${esc(EFF[a.effort] || a.effort)}</span>` : ''}${L(a.cost) ? `<span class="tag">💵 ${esc(L(a.cost))}</span>` : ''}${L(a.owner) ? `<span class="tag">👤 ${esc(L(a.owner))}</span>` : ''}${a.deadline ? `<span class="tag">📅 ${esc(F.dt(a.deadline))}</span>` : ''}</div></div>`;
  const all = [...(roles || []), dir && dir.advice && { role: 'director', advice: dir.advice }].filter(Boolean);
  const p5 = head(esc(title)) + sec('🗣', T('Советы членов совета', 'Advice from the board'), `${all.reduce((s, r) => s + (r.advice || []).length, 0)} ${T('советов', 'items')}`)
    + all.map((r) => `<div class="role"><div class="rh"><span class="ic">${ROLE_ICON[r.role] || '•'}</span>${esc((ROLE_NAMES[r.role] || {})[lang] || r.role)}</div>`
      + `${r.summary ? `<div class="sum">${esc(L(r.summary))}</div>` : ''}${(r.findings || []).length ? `<ul>${r.findings.map((x) => `<li>${esc(L(x))}</li>`).join('')}</ul>` : ''}`
      + `<div class="grid two">${(r.advice || []).map(advCard).join('')}</div></div>`).join('');

  /* ── 6. Словарь и источники ── */
  const p6 = head(esc(title)) + sec('📖', T('Словарь', 'Glossary'))
    + `<table class="gl-t"><tbody>${GLOSSARY.map(([r, rd, e, ed]) => `<tr><td style="width:28%"><b>${esc(F.ru ? r : e)}</b></td><td>${esc(F.ru ? rd : ed)}</td></tr>`).join('')}</tbody></table>`
    + sec('🔎', T('Откуда цифры', 'Where the numbers come from')) + `<div class="note">${T(
      'Занятия, дети и зарплата — отчёт Payroll в in2. Деньги, активные дети, пробные, продления — Джарвис (те же расчёты, что в приложении). Заявки и скорость ответа — база заявок (момент ответа — кнопка «✅ Ответил»). Ошибки админов — счета in2 со скидкой ровно 100 QAR без пробного занятия. Оплата управляющего 11 000 QAR — оценка по открытым данным (GulfTalent, объявления), не факт. Советы написаны ролями-ботами на основе этих данных; решения принимает владелец.',
      'Classes, kids and pay come from the in2 Payroll report. Money, active kids, trials and renewals come from Jarvis (the same calculations as in the app). Leads and reply times come from the leads database (the reply is when “✅ Responded” is pressed). Admin errors are in2 invoices with a discount of exactly 100 QAR and no trial class. The 11,000 QAR manager pay is an estimate from public data (GulfTalent, job ads), not a fact. The advice is written by role bots from this data; the owner makes the decisions.')}</div>`;

  return `<!doctype html><html lang="${lang}" data-theme="${app ? theme : 'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${T('Совет директоров', 'Board of directors')} · ${esc(title)}</title><style>${font}${CSS}</style></head><body>`
    + page(p1, true) + (dir ? page(p2) : '') + page(p3) + page(p4) + (dir ? page(p5) : '') + page(p6) + `</body></html>`;
}

/* PDF A4 из того же HTML (печатная вёрстка — @media print) */
async function renderPdf(htmlText, out) {
  const { chromium } = require('/home/admin/acrogym-design-system/.ds-sync/node_modules/playwright');
  const b = await chromium.launch();
  try {
    const p = await b.newPage();
    await p.setContent(htmlText, { waitUntil: 'load' });
    await p.pdf({ path: out, format: 'A4', printBackground: true, displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:7px;color:#8a8fa3;width:100%;text-align:center">AcroGym · <span class="pageNumber"></span>/<span class="totalPages"></span></div>',
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
  } finally { await b.close(); }
}

module.exports = { html, kpis, renderPdf, STRATEGY, ROLES, ROLE_NAMES, KPI_NAMES };
