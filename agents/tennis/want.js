#!/usr/bin/env node
/* Теннис «по заказу» (владелец 16.10.2026): дата из Джарвиса → пробуем всё, что можем, один корт на день:
 *   1) UDC через API (udc_booker --execute-once: Giardino → Family Park, пара → один час), 2) UDST (пара 18–22, только вечер), иначе ждём.
 * Дата в пределах 7 дней — пробуем сразу и потом каждые полчаса (освобождения), пока не возьмём или не начнётся окно.
 * Дальше 7 дней — ждёт: в момент открытия брони её берут штатные агенты (udc-run.js 00:00, udst.js --run), правила недели для заказа не действуют.
 *   node agents/tennis/want.js --add '{"date":"2026-10-22","slot":"evening|morning"}' [--later] | --del ГГГГ-ММ-ДД | --list | --tick (крон 12,42) | --selftest
 */
const fs = require('fs'), { execFileSync } = require('child_process'), W = require('./week');
const ROOT = __dirname + '/../..', Q = ROOT + '/data/tennis-want.json';
const log = (...a) => console.log(new Date().toISOString(), '[want]', ...a);
const doha = (ms = Date.now()) => new Date(ms + 3 * 3600e3).toISOString(); /* Доха UTC+3 */
const days = (date, now = doha()) => Math.round((Date.parse(date) - Date.parse(now.slice(0, 10))) / 864e5);
const START = { evening: 18, morning: 7 };
const load = () => { try { return JSON.parse(fs.readFileSync(Q, 'utf8')); } catch { return []; } };
const save = (q) => fs.writeFileSync(Q, JSON.stringify(q, null, 1));

/** уже есть игра в этот день и это время суток? (UDC/ChatGPT — tennis.json, UDST — udst.json) */
function held(it) {
  const ev = it.slot === 'evening';
  if ((W.load('tennis.json', { booked: [] }).booked || []).some((b) => b.date === it.date && (b.start >= 17) === ev)) return true;
  return ev && !!(W.load('udst.json', {})[it.date] || {}).got?.length;
}
/** проверка заказа: дата ГГГГ-ММ-ДД от сегодня до +60 дней, не пт/сб, утро — только понедельник (так открыт UDC) */
function parse(j, now = doha()) {
  const it = { date: String(j?.date || ''), slot: j?.slot === 'morning' ? 'morning' : 'evening' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date) || isNaN(Date.parse(it.date))) return { err: 'дата ГГГГ-ММ-ДД' };
  const n = days(it.date, now), dw = W.dow(it.date);
  if (n < 0 || n > 60) return { err: 'дата от сегодня до +60 дней' };
  if (dw === 5 || dw === 6) return { err: 'пятница и суббота — корты не бронируем (окно UDC вс–чт)' };
  if (it.slot === 'morning' && dw !== 1) return { err: 'утро 7–9 бывает только в понедельник' };
  return it;
}
/** пора пробовать сейчас: в пределах 7 дней, окно ещё не началось, с прошлой попытки ≥25 мин */
const HORIZON = 7; /* 18.10 владелец: правило 7 дней (UDC пускает и дальше — не используем); бронь без оплаты живёт 5 мин → пробуем только днём 8–22, когда владелец может сразу оплатить */
const due = (it, now = doha()) => it.status === 'queued' && days(it.date, now) <= HORIZON && +now.slice(11, 13) >= 8 && +now.slice(11, 13) < 22 &&
  !(days(it.date, now) === 0 && +now.slice(11, 13) >= START[it.slot]) && (!it.tried || Date.parse(now) - Date.parse(it.tried) >= 25 * 60e3);

async function attempt(it) {
  const { udc, notify } = require('./udc-run');
  it.tried = doha(); it.tries = (it.tries || 0) + 1;
  if (held(it)) return (it.status = 'done', log(it.date, 'уже есть игра'));
  const r = await udc(['--execute-once', it.date, '--window', it.slot], { quiet: true });
  if (r === 'booked') return (it.status = 'done', it.via = 'udc');
  if (r === 'review') return (it.status = 'review'); /* код UDC просит человека — дальше не лезем, пуш уже ушёл */
  if (it.slot === 'evening') {
    let out = ''; try { out = execFileSync('node', [__dirname + '/udst.js', '--book', it.date, ...(process.env.DRY ? ['--dry'] : [])], { cwd: ROOT, encoding: 'utf8', timeout: 5 * 60e3 }); } catch (e) { out = (e.stdout || '') + e.message; }
    const m = out.match(/^RESULT (.+)$/m), u = m ? JSON.parse(m[1]) : null;
    log('udst', it.date, m ? m[1] : out.trim().slice(-300));
    if (u?.ok) return (it.status = 'done', it.via = 'udst');
  }
  if (it.tries === 1) notify(`🎾 ${it.date}: пока мест нет`, `${it.slot === 'evening' ? 'Вечер' : 'Утро'}: UDC${it.slot === 'evening' ? ' и UDST' : ''} заняты. Пробую каждые полчаса до начала.`);
}

async function tick() {
  const L = Q + '.lock'; /* одна попытка за раз: крон и кнопка Джарвиса не должны бронировать одновременно */
  try { fs.writeFileSync(L, String(process.pid), { flag: 'wx' }); } catch { if (Date.now() - fs.statSync(L).mtimeMs < 15 * 60e3) return log('занято другим запуском'); fs.writeFileSync(L, String(process.pid)); }
  try { await tickLocked(); } finally { fs.rmSync(L, { force: true }); }
}
async function tickLocked() {
  const q = load(), now = doha();
  for (const it of q) {
    if (it.status !== 'queued') continue;
    if (days(it.date, now) < 0 || (days(it.date, now) === 0 && +now.slice(11, 13) >= START[it.slot])) {
      it.status = 'missed'; require('./udc-run').notify(`🎾 ${it.date}: не вышло`, 'Корт так и не освободился.'); continue;
    }
    if (held(it)) { it.status = 'done'; continue; } /* взяли штатные агенты в момент открытия */
    if (due(it, now)) await attempt(it);
    save(q);
  }
  save(q);
}

function selftest() {
  const A = require('assert'), now = '2026-10-16T10:00:00.000Z'; /* пт */
  A.equal(days('2026-10-23', now), 7); A.equal(days('2026-10-16', now), 0);
  A.ok(parse({ date: '2026-10-17' }, now).err); /* сб */
  A.ok(parse({ date: '2026-10-20', slot: 'morning' }, now).err); /* вт утро */
  A.deepEqual(parse({ date: '2026-10-19', slot: 'morning' }, now), { date: '2026-10-19', slot: 'morning' });
  A.equal(parse({ date: '2026-10-22', slot: 'x' }, now).slot, 'evening');
  A.ok(parse({ date: '2026-10-15' }, now).err); A.ok(parse({ date: '2027-01-01' }, now).err);
  A.ok(due({ status: 'queued', date: '2026-10-22', slot: 'evening' }, now));
  A.ok(!due({ status: 'queued', date: '2026-10-25', slot: 'evening' }, now)); /* +9 дней — ждёт: правило 7 дней */
  A.ok(!due({ status: 'queued', date: '2026-10-22', slot: 'evening' }, '2026-10-16T23:10:00.000Z')); /* ночью не пробуем */
  A.ok(!due({ status: 'queued', date: '2026-10-22', slot: 'evening', tried: '2026-10-16T09:50:00.000Z' }, now));
  A.ok(!due({ status: 'queued', date: '2026-10-16', slot: 'evening' }, '2026-10-16T18:10:00.000Z')); /* окно уже началось */
  console.log('selftest ok');
}

const arg = process.argv.slice(2);
(async () => {
  if (arg.includes('--selftest')) return selftest();
  if (arg.includes('--list')) return console.log(JSON.stringify(load()));
  if (arg.includes('--tick')) return tick();
  if (arg.includes('--del')) { const d = arg[arg.indexOf('--del') + 1], q = load(); for (const x of q) if (x.date === d && x.status === 'queued') x.status = 'removed'; save(q); return console.log(JSON.stringify({ ok: true })); }
  if (arg.includes('--add')) {
    let j = null; try { j = JSON.parse(arg[arg.indexOf('--add') + 1]); } catch (_) {}
    const it = parse(j); if (it.err) return console.log(JSON.stringify({ ok: false, err: it.err }));
    const q = load(), old = q.find((x) => x.date === it.date && x.slot === it.slot && x.status === 'queued');
    if (old) return console.log(JSON.stringify({ ok: true, duplicate: true, item: old }));
    Object.assign(it, { status: 'queued', at: doha() }); q.push(it); save(q);
    if (due(it) && !arg.includes('--later')) { await attempt(it); save(q); } /* --later: только в очередь (мост Джарвиса), пробует фоновый --tick */
    return console.log(JSON.stringify({ ok: true, item: it }));
  }
  console.log('usage: --add <json> | --del <date> | --list | --tick | --selftest');
})().catch((e) => { log('FATAL', e.message); process.exitCode = 1; });
