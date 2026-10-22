/* Правила недели (владелец 15.10.2026), общие для писем UDC (index.js) и UDST (udst.js):
   20.10 владелец: в будни вечером до 3 игр за неделю (вс–чт), но не больше 2 вечеров подряд (было: не больше 2 за неделю); лучшие дни вс, пн, ср, идеал вс+ср — были вс+пн и удалось взять ср: ср берём, пн отменяем;
   чт — запасной, если к нему меньше 2 игр; вт не берём; Pearl (UDC) важнее UDST — в один день UDST не нужен. */
const fs = require('fs');
const DATA = __dirname + '/../../data/';
const RANK = { 0: 0, 3: 0, 1: 1, 4: 2 }; /* вс, ср — лучшие; пн; чт — запасной; остальные не берём */
const rank = (d) => RANK[dow(d)] ?? 9;
const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const weekOf = (d) => new Date(Date.parse(d + 'T00:00:00Z') - dow(d) * 864e5).toISOString().slice(0, 10); /* воскресенье недели */
const load = (f, def) => { try { return JSON.parse(fs.readFileSync(DATA + f, 'utf8')); } catch { return def; } };

/** вечерние игры недели дня d: [{date, src:'udc'|'udst', ref}] (UDC — подтверждённые/ChatGPT, UDST — взятая пара) */
function games(d, tennis = load('tennis.json', { booked: [] }), udst = load('udst.json', {})) {
  const w = weekOf(d), out = [];
  for (const b of tennis.booked || []) if (b.start >= 17 && weekOf(b.date) === w) out.push({ date: b.date, src: 'udc', ref: b });
  for (const [k, v] of Object.entries(udst)) if (/^\d{4}-\d\d-\d\d$/.test(k) && v.done === 'ok' && !(tennis.udstDropped || {})[k] && weekOf(k) === w) out.push({ date: k, src: 'udst', ref: v });
  return out;
}
const MAX = 3; /* 20.10 владелец: «надо 3 раза в неделю, только подряд можно 2 вечера, 3 подряд не надо» */
const DAY = 864e5;
/** есть ли 3 вечера подряд среди дат */
const run3 = (dates) => { const t = [...new Set(dates)].map((x) => Date.parse(x + 'T00:00:00Z')).sort((a, b) => a - b); return t.some((x, i) => i >= 2 && x - t[i - 2] === 2 * DAY); };
/** что отменить: UDST в день, где есть Pearl; всё сверх 3 дней и третий вечер подряд — худшие по рангу, при равенстве более поздние */
function extra(list) {
  const drop = [], days = new Map();
  for (const g of list) (days.get(g.date) || days.set(g.date, []).get(g.date)).push(g);
  for (const gs of days.values()) if (gs.some((g) => g.src === 'udc')) drop.push(...gs.filter((g) => g.src === 'udst'));
  const order = [...days.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const keep = [];
  for (const d of order) { if (keep.length < MAX && !run3([...keep, d])) keep.push(d); else drop.push(...days.get(d).filter((g) => !drop.includes(g))); }
  return drop;
}
/** просить/брать ли вечер дня d при уже взятых играх недели */
function want(d, list = games(d)) {
  if (rank(d) === 9) return false;
  const days = [...new Set(list.map((g) => g.date))].filter((x) => x !== d);
  return days.length < MAX && !run3([...days, d]);
}
module.exports = { dow, weekOf, load, games, extra, want, run3, MAX };

if (require.main === module) { /* node week.js — самопроверка; неделя 25–29.10.2026: вс 25, пн 26, вт 27, ср 28, чт 29 */
  const A = require('assert'), g = (date, src = 'udc') => ({ date, src });
  A.deepStrictEqual(extra([g('2026-10-25'), g('2026-10-26'), g('2026-10-28')]), []); /* вс+пн+ср — 3 вечера, подряд только 2 — ок */
  A.deepStrictEqual(extra([g('2026-10-25'), g('2026-10-26'), g('2026-10-28'), g('2026-10-29')]).map((x) => x.date), ['2026-10-29']); /* 4-й (чт, худший) — лишний */
  A.deepStrictEqual(extra([g('2026-10-25'), g('2026-10-28', 'udst'), g('2026-10-28')]).map((x) => x.src), ['udst']); /* в один день Pearl важнее */
  A.deepStrictEqual(extra([g('2026-10-25'), g('2026-10-25'), g('2026-10-28')]), []); /* два блока в один день — одна игра */
  A.ok(want('2026-10-28', [g('2026-10-25'), g('2026-10-26')])); /* ср при вс+пн — третий вечер, не подряд — берём */
  A.ok(!want('2026-10-29', [g('2026-10-25'), g('2026-10-26'), g('2026-10-28')])); /* уже 3 — четвёртый нет */
  A.ok(want('2026-10-29', [g('2026-10-25'), g('2026-10-28')])); /* чт третьим — ср+чт подряд 2 — ок */
  A.ok(!want('2026-10-27', [])); /* вт не берём */
  A.ok(run3(['2026-10-26', '2026-10-27', '2026-10-28']) && !run3(['2026-10-25', '2026-10-26', '2026-10-28'])); /* 3 подряд ловится */
  A.strictEqual(weekOf('2026-10-29'), '2026-10-25');
  console.log('week selftest ok');
}
