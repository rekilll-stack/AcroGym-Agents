'use strict';
/* ⚠️ ВАЖНО (владелец 18.09): этот скрипт годится ТОЛЬКО для по-настоящему новой группы
   (новое название/возраст/тренер). POST /classes всегда создаёт ОТДЕЛЬНУЮ карточку в Schedule
   Management, из-за чего уже расплодились дубли («7-10 · Andrey» две карточки и т.д.).
   Новый слот существующей группе добавлять В ПАНЕЛИ: Activities → Schedule Management →
   нужная карточка → «Add Schedule» — она наследует название, категорию, тренера, комнату,
   возраст, места и сразу даёт привязать пакеты. После любого создания проверять:
   пакеты привязаны, Pay Rate = Group Class, Outdoors ☐, Ignore Room ☑, обложка, места. */
/* Добавить занятия в расписание in2 по правилам сезона 2026/27. Серия на весь сезон, каникулы гасятся,
   чужие занятия не трогаются. Вместимость по правилу зала: будни до 12:00 — 6 мест, суббота и день — 10.
   node add-class.js            → сухой прогон
   node add-class.js --go       → создать */
require('/home/admin/acrogym/node_modules/dotenv').config({ path: '/home/admin/acrogym/.env' });
const in2 = require('/home/admin/acrogym/shared/in2');
const GO = process.argv.includes('--go');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || ''; // один день за раз, когда остальные уже созданы

/* что добавляем сейчас (владелец 17.09: Кристине суббота 15:00 и четверг 16:30, обе 7-10) */
const CLASSES = [
  { day: 'Saturday', time: '15:20', group: '7-10', coach: 'Kristina', idTrainer: 19471, fromAge: 7, toAge: 10 },
  { day: 'Thursday', time: '16:30', group: '7-10', coach: 'Kristina', idTrainer: 19471, fromAge: 7, toAge: 10 },
];
const SEASON_END = '2027-06-24', BREAKS = [['2026-12-18', '2027-01-03'], ['2027-03-08', '2027-03-20']];
const BRANCH = 2265, CATEGORY = 72, DURATION = 50, PRICE = 0; /* категория Gymnastics = 72 (в сезонной заливке стояла фиктивная 1) */
/* правило владельца: утро буднего дня (до 12:00) — 6 детей, суббота и всё дневное — 10 */
const slotsFor = (day, time) => (day !== 'Saturday' && day !== 'Sunday' && +time.slice(0, 2) < 12 ? 6 : 10);
const LOC = { countryCode: 'QA', city: 'Doha Municipality', locationName: 'Lagoona Mall', longitude: 51.5254561, latitude: 25.3761167 };
const WD = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
const add = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
const inBreak = (d) => BREAKS.some(([a, b]) => d >= a && d <= b);
const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

async function one(C) {
  const SLOTS = slotsFor(C.day, C.time);
  /* если сегодня нужный день и время ещё не прошло — начинаем с сегодня, иначе с ближайшего следующего */
  const nowHHMM = new Date(Date.now() + 3 * 3600e3).toISOString().slice(11, 16);
  let first = dow(today) === WD[C.day] && nowHHMM < C.time ? today : add(today, 1);
  while (dow(first) !== WD[C.day]) first = add(first, 1);
  const dates = []; for (let d = first; d <= SEASON_END; d = add(d, 7)) dates.push(d);
  const live = dates.filter((d) => !inBreak(d)), cancel = dates.filter((d) => inBreak(d));
  const title = `Gymnastics ${C.group} · ${C.coach}`;
  const body = {
    title, description: `Kids gymnastics group, ages ${C.group}. 50-minute session at AcroGym, Lagoona Mall.`,
    idCategory: CATEGORY, idTrainer: C.idTrainer, idTenantBranch: BRANCH,
    slots: SLOTS, price: PRICE, fromAge: C.fromAge, toAge: C.toAge, ...LOC,
    sessionType: 'WEEKLY', occurences: dates.length - 1,
    times: [{ startDate: `${first} ${C.time}:00`, duration: DURATION }],
  };
  console.log(`${title} · ${C.day} ${C.time} · мест ${SLOTS} · ${DURATION} мин · категория ${CATEGORY} · тренер ${C.idTrainer}`);
  console.log(`серия: ${first} … ${dates[dates.length - 1]} = ${dates.length} занятий, из них в каникулы ${cancel.length} (${cancel.join(', ')}) → останется ${live.length}`);

  /* конфликты: тренер и зал в это время */
  for (const d of [first, add(first, 7)]) {
    const ev = await in2.call('/classes/events?selectedDate=' + d);
    const busy = (Array.isArray(ev) ? ev : []).filter((e) => {
      const s = e.startTime || '', dur = +e.duration || 50, [h, m] = s.split(':').map(Number);
      const a = h * 60 + m, b = a + dur, [nh, nm] = C.time.split(':').map(Number), na = nh * 60 + nm, nb = na + DURATION;
      return a < nb && na < b;
    });
    console.log(`  ${d}: пересечений по времени ${busy.length}${busy.length ? ' → ' + busy.map((e) => e.startTime + ' ' + e.title).join('; ') : ' (зал и тренер свободны)'}`);
  }
  if (!GO) { console.log('  сухой прогон, ничего не создано\n'); return null; }

  const r = await in2.call('/classes', { method: 'POST', body });
  console.log('создано:', JSON.stringify(r).slice(0, 300));
  let done = 0;
  for (const d of cancel) {
    const ev = await in2.call('/classes/events?selectedDate=' + d);
    for (const e of (Array.isArray(ev) ? ev : [])) {
      if (e.title !== title || (e.startTime || '').slice(0, 5) !== C.time) continue; /* гасим ТОЛЬКО своё занятие */
      await in2.call(`/classes/occurrences/${e.id}/cancel`, { method: 'POST', body: {} }); done++;
    }
  }
  console.log('  отменено в каникулы:', done, 'из', cancel.length, '\n');
  return { title, first, live: live.length };
}

(async () => {
  const out = [];
  for (const C of CLASSES) { if (ONLY && C.day !== ONLY) continue; out.push(await one(C)); }
  if (!GO) console.log('Запуск: node add-class.js --go');
  else console.log('ИТОГО создано:', out.filter(Boolean).map((x) => x.title + ' (' + x.live + ' занятий)').join('; '));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
