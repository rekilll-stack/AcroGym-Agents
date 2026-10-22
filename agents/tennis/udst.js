#!/usr/bin/env node
/* Теннис UDST Sport (Planyo, udstsport.udst.edu.qa): 2 часа подряд в будни Катара (вс–чт) между 18 и 22.
 * Правила владельца (15.10.2026): нужно 2 часа; за раз сайт даёт 1 час; одинокий час не берём (21:00 в одиночку — поздно).
 * Слот открывается ровно за 7×24 ч до начала → крон вс–чт в 17:59/18:59/19:59/20:59, каждый запуск ждёт HH:00:00
 * и берёт только что открывшийся час: пары 18–20, 19–21, 20–22. Платит владелец сам: ссылку на оплату шлём в Джарвис.
 * Если UDC (agents/tennis/index.js) уже подтвердил корт на этот день — UDST не трогаем (без двух кортов в один вечер).
 *   node agents/tennis/udst.js --run [--now] | --book ГГГГ-ММ-ДД [--dry] (разовая, для want.js) | --sync (оплаченные игры → календарь rekilll) | --check [ГГГГ-ММ-ДД] | --selftest
 */
const fs = require('fs');
const ROOT = __dirname + '/../..', STATE = ROOT + '/data/udst.json', SESSION = ROOT + '/.secrets/udst-state.json';
const PW = '/home/admin/acrogym-design-system/.ds-sync/node_modules/playwright';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const W = require('./week.js'); /* правила недели (15.10): не больше 2 вечеров, лучшие вс/пн/ср, Pearl важнее */
const LAST_START = 20; /* пара должна закончиться не позже 22:00 */

const log = (...a) => console.log(new Date().toISOString(), '[udst]', ...a);
const doha = (ms = Date.now()) => new Date(ms + 3 * 3600e3); /* Доха UTC+3 без летнего времени */
const iso = (d) => d.toISOString().slice(0, 10);
const plus = (day, n) => iso(new Date(Date.parse(day + 'T00:00:00Z') + n * 864e5));
const dow = (day) => new Date(day + 'T00:00:00Z').getUTCDay();
const planyoDate = (day) => { const d = new Date(day + 'T00:00:00Z'); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
const url = (day, h) => { const d = encodeURIComponent(planyoDate(day)); return `https://udstsport.udst.edu.qa/booking?calendar=56012&custom-language=EN&mode=reserve&one_date=${d}&planyo_lang=en&prefill=true&prop_res_activity=Tennis&prop_res_client=Public&resource_id=244950&start_date=${d}&start_time=${h}`; };
const load = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };

/** какой час брать в запуск h (час только что открылся); got — взятые часы дня. null — ничего */
const pick = (got, h) => (got.includes(h - 1) || h <= LAST_START ? h : null);
/** пара собрана? */
const paired = (got) => got.some((x) => got.includes(x + 1));
/** есть ли шанс собрать пару в следующих запусках (после часа h) */
const hope = (got, h) => (got.includes(h) && h + 1 <= LAST_START + 1) || h + 1 <= LAST_START;

function notify(title, body) { /* как в index.js: таблица notif почтового секретаря → алерты моста → пуш в Джарвис */
  try {
    const db = new (require('better-sqlite3'))(ROOT + '/data/mail.db');
    db.prepare('INSERT OR REPLACE INTO notif(id,title,body,at) VALUES(?,?,?,?)').run('udst-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), title, body, new Date().toISOString());
    db.close();
  } catch (e) { log('notif ERR', e.message); }
  log('PUSH', title, '|', body);
}

async function login(p) {
  const env = Object.fromEntries(fs.readFileSync(ROOT + '/.secrets/udst.env', 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  await p.fill('input[name=user_login]:visible', env.UDST_USER); await p.fill('input[name=password]:visible', env.UDST_PASS);
  await Promise.all([p.waitForLoadState('networkidle').catch(() => {}), p.click('text=LOGIN >> visible=true')]);
  log('перелогин');
}
/** открыть форму брони на день/час; вернуть {ok, why} — ok: час свободен и цена показана */
async function form(p, day, h) {
  await p.goto(url(day, h), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForSelector('input[name=submit_button]:visible, input[name=user_login]:visible', { timeout: 30000 }); /* :visible — иначе берётся скрытый логин из модалки и ждём до таймаута */
  if (await p.$('input[name=user_login]:visible')) { await login(p); await p.goto(url(day, h), { waitUntil: 'domcontentloaded', timeout: 60000 }); await p.waitForSelector('input[name=submit_button]', { timeout: 30000 }); }
  await p.waitForTimeout(1500); /* Planyo досчитывает цену скриптом */
  return p.evaluate((h) => {
    const sel = document.querySelector('select[name=start_time]'), o = sel && [...sel.options].find((x) => +x.value === h);
    const t = document.body.innerText, i = t.indexOf('Your rate'), rate = i < 0 ? '' : t.slice(i, i + 100).replace(/\s+/g, ' ');
    const opts = sel ? [...sel.options] : [];
    return { ok: !!o && !/\[X\]/.test(o.text) && /QAR/.test(rate), why: (o ? o.text.trim() : 'нет часа в списке') + ' | ' + (rate || 'цены нет'),
      opts: opts.map((x) => x.text.trim()), taken: opts.filter((x) => /\[X\]/.test(x.text)).map((x) => +x.value) }; /* [X] видно заранее, ещё до открытия окна */
  }, h);
}
/** забронировать час; вернуть ссылку на оплату (или null) */
async function book(p, day, h) {
  await Promise.all([p.waitForLoadState('networkidle').catch(() => {}), p.click('input[name=submit_button]')]);
  await p.waitForTimeout(4000);
  const step = p.url(), text = await p.evaluate(() => document.body.innerText);
  const res = (text.match(/\bR?(\d{8})\b/) || [])[1] || '?';
  if (!/payment/i.test(text)) throw new Error('после Book Now нет шага оплаты: ' + text.replace(/\s+/g, ' ').slice(0, 200));
  const btn = await p.$('text=/Make online payment/i >> visible=true');
  let pay = step;
  if (btn) { await Promise.all([p.waitForLoadState('load').catch(() => {}), btn.click()]); await p.waitForTimeout(5000); if (new URL(p.url()).search) pay = p.url(); } /* FalconPay открывается POST-формой: голый URL без параметров пустой → шлём ссылку на бронь с кнопкой оплаты */
  log('бронь', day, h + ':00', 'R' + res, '| шаг оплаты', step, '| платёжная', pay);
  return { res, pay, step };
}
const until = (h) => { const now = doha(), t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h) - 3 * 3600e3 + 500; return Math.max(0, t - Date.now()); };

async function run(now) {
  const n = doha(Date.now() + 90e3), h = now ? doha().getUTCHours() : n.getUTCHours(); /* крон в HH-1:59 → целевой час HH */
  const day = plus(iso(n), 7);
  if ([5, 6].includes(dow(day)) || h < 18 || h > LAST_START + 1) return log('не время', day, h);
  const st = load(STATE, {}), d = (st[day] ||= { got: [], pay: {} });
  const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  if (d.done) return log(day, 'уже закрыт');
  if ((load(ROOT + '/data/tennis.json', { booked: [] }).booked || []).some((x) => x.date === day)) { d.done = 'udc'; save(); return notify('🎾 UDST не бронирую', `${day}: корт уже подтвердил UDC`); }
  if (!d.got.length && !W.want(day) && !(W.load('tennis-want.json', []) || []).some((x) => x.date === day && x.status === 'queued')) { d.done = 'rules'; save(); return log(day, 'правила недели: не беру'); }
  const want = pick(d.got, h);
  if (want === null) return log(day, h, 'нечего брать', d.got);

  const { chromium } = require(PW), b = await chromium.launch();
  try {
    const ctx = await b.newContext({ storageState: fs.existsSync(SESSION) ? SESSION : undefined }), p = await ctx.newPage();
    let w = await form(p, day, want); /* прогрев: вход и кэш до открытия окна */
    if (until(want) > 25000) { await new Promise((r) => setTimeout(r, until(want) - 20000)); w = await form(p, day, want); } /* свежая форма за ~20 с до открытия — в T жмём «Book» без перезагрузки */
    if (w.taken.includes(want) || (!d.got.includes(want - 1) && w.taken.includes(want + 1))) log(day, want + ':00 занято заранее (одинокий час не берём), заняты:', w.taken);
    else {
      /* 20.10: на 26.10 час 18 и 20 забрали за ~15 с, а мы после открытия перезагружали форму и жали «Book» только через 18–20 с.
         Теперь форма открыта заранее, и в момент открытия (T+0,5 с) сразу жмём «Book»; не прошло — прежний цикл с перезагрузкой. */
      await new Promise((r) => setTimeout(r, until(want)));
      let first = false;
      try { const r = await book(p, day, want); d.got.push(want); d.pay[want] = r.pay; first = true; log(day, want + ':00 взят первым кликом'); }
      catch (e) { log(day, want + ':00 первый клик не прошёл:', e.message.slice(0, 160)); }
      if (!first) {
        let f;
        for (let i = 0; i < 6; i++) { f = await form(p, day, want); if (f.ok || f.taken.includes(want)) break; log('ждём', want, f.why); await p.waitForTimeout(1000); }
        if (f.ok) { const r = await book(p, day, want); d.got.push(want); d.pay[want] = r.pay; }
        else log(day, want + ':00 не дали:', f.why);
      }
    }
    await ctx.storageState({ path: SESSION });
    fs.chmodSync(SESSION, 0o600);
  } finally { await b.close(); }

  const hh = (x) => `${x}:00–${x + 1}:00`;
  if (paired(d.got)) {
    const a = d.got.find((x) => d.got.includes(x + 1)); d.done = 'ok';
    notify('🎾 UDST: 2 часа взяты — оплати', `${day} ${a}:00–${a + 2}:00. Оплата картой по каждому часу:\n${hh(a)}: ${d.pay[a]}\n${hh(a + 1)}: ${d.pay[a + 1]}`);
  } else if (d.got.includes(want)) notify('🎾 UDST: 1-й час взят', `${day} ${hh(want)}. Второй час откроется в ${want + 1}:00 — пока не оплачивай.\n${d.pay[want]}`);
  else if (d.got.includes(want - 1)) notify('🎾 UDST: второй час не дали', `${day} ${hh(want)} занят — ${hh(want - 1)} остался один, НЕ оплачивай.`);
  if (!d.done && !hope(d.got, h)) { d.done = 'fail'; notify('🎾 UDST: 2 часа подряд не вышло', `${day}: свободной пары 18–22 не было.`); }
  save();
}

/** «Upcoming reservations» из кабинета → [{date, start, end, ids, res}]; там только оплаченные (Confirmed), по строке на час; соседние часы склеиваем */
function upcoming(text) {
  const s = text.slice(text.indexOf('Upcoming reservations'), text.indexOf('Cancelled reservations')), out = [];
  for (const m of s.matchAll(/(\d{8})\s+([A-Z][a-z]{2}) (\d{2}), (\d{4})\s+(\d{2}):\d{2} (am|pm)\s+(.+?)\s+Confirmed/g)) {
    const date = `${m[4]}-${String(MON.indexOf(m[2]) + 1).padStart(2, '0')}-${m[3]}`, start = (+m[5] % 12) + (m[6] === 'pm' ? 12 : 0);
    out.push({ date, start, end: start + 1, ids: [m[1]], res: m[7].trim() });
  }
  return out.sort((a, b) => (a.date + String(a.start).padStart(2, '0')).localeCompare(b.date + String(b.start).padStart(2, '0')))
    .reduce((acc, x) => { const p = acc[acc.length - 1]; if (p && p.date === x.date && p.end === x.start) { p.end = x.end; p.ids.push(...x.ids); } else acc.push(x); return acc; }, []);
}
async function gcal(method, path, body) { /* календарь rekilll (тот же токен, что у агента UDC) */
  const c = JSON.parse(fs.readFileSync('/home/admin/mcp-servers/gmail/credentials-cal.json', 'utf8'));
  const t = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: 'refresh_token' }) })).json();
  const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events' + path, { method, headers: { Authorization: 'Bearer ' + t.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('calendar ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return (await r.json()).id;
}
/** оплаченные игры UDST → календарь; второй оплаченный час дописывает событие дня, а не плодит новое */
async function sync() {
  const { chromium } = require(PW), b = await chromium.launch(); let text;
  try {
    const ctx = await b.newContext({ storageState: SESSION }), p = await ctx.newPage(), home = 'https://udstsport.udst.edu.qa/home';
    await p.goto(home, { waitUntil: 'networkidle', timeout: 60000 });
    if (await p.$('input[name=user_login]:visible')) { await login(p); await p.goto(home, { waitUntil: 'networkidle', timeout: 60000 }); }
    await p.waitForSelector('text=Upcoming reservations', { timeout: 30000 });
    text = await p.evaluate(() => document.body.innerText); await ctx.storageState({ path: SESSION });
  } finally { await b.close(); }
  const st = load(STATE, {}), cal = (st.cal ||= {});
  for (const g of upcoming(text)) {
    const key = `${g.start}-${g.end}`, have = cal[g.date];
    if (have && have.key === key) continue;
    const hh = (x) => String(x).padStart(2, '0') + ':00:00';
    const ev = { summary: '🎾 Теннис', location: 'UDST Sport — ' + g.res + ', Duhail North', description: 'Бронь UDST ' + g.ids.map((x) => 'R' + x).join(', ') + ' (оплачено), поставил теннис-агент',
      start: { dateTime: `${g.date}T${hh(g.start)}`, timeZone: 'Asia/Qatar' }, end: { dateTime: `${g.date}T${hh(g.end)}`, timeZone: 'Asia/Qatar' } };
    cal[g.date] = { key, id: have ? await gcal('PATCH', '/' + have.id, ev) : await gcal('POST', '', ev) };
    fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
    notify('🎾 Игра в календаре', `${g.date} ${g.start}:00–${g.end}:00 · UDST (оплачено)`);
  }
}

async function check(day) { /* только чтение: что показывает форма */
  const { chromium } = require(PW), b = await chromium.launch();
  try { const p = await (await b.newContext({ storageState: SESSION })).newPage(); for (const h of [18, 19, 20, 21]) { const f = await form(p, day, h); console.log(day, h, f.ok ? 'СВОБОДНО' : 'нет', '|', f.why); if (h === 18) console.log('часы:', f.opts.join(' · ')); } }
  finally { await b.close(); }
}

/** разовая бронь из очереди Джарвиса (want.js): первая пара 18–20/19–21/20–22, где оба часа уже открыты и свободны; одинокий час не берём */
async function bookNow(day, dry) {
  const st = load(STATE, {}), d = (st[day] ||= { got: [], pay: {} }), save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  if (d.got.length) return { ok: true, already: d.got };
  const { chromium } = require(PW), b = await chromium.launch();
  try {
    const ctx = await b.newContext({ storageState: fs.existsSync(SESSION) ? SESSION : undefined }), p = await ctx.newPage(), f = {};
    for (const h of [18, 19, 20, 21]) f[h] = await form(p, day, h);
    const a = [18, 19, 20].find((h) => f[h].ok && f[h + 1].ok);
    if (a === undefined || dry) return { ok: false, dry, pair: a ?? null, free: [18, 19, 20, 21].filter((h) => f[h].ok) };
    for (const h of [a, a + 1]) {
      const g = await form(p, day, h);
      if (!g.ok) break;
      const r = await book(p, day, h); d.got.push(h); d.pay[h] = r.pay; save();
    }
    await ctx.storageState({ path: SESSION }); fs.chmodSync(SESSION, 0o600);
    const hh = (x) => `${x}:00–${x + 1}:00`;
    if (paired(d.got)) { d.done = 'ok'; save(); notify('🎾 UDST: 2 часа взяты — оплати', `${day} ${a}:00–${a + 2}:00. Оплата картой по каждому часу:\n${hh(a)}: ${d.pay[a]}\n${hh(a + 1)}: ${d.pay[a + 1]}`); return { ok: true, from: a, to: a + 2 }; }
    if (d.got.length) notify('🎾 UDST: второй час не дали', `${day} ${hh(d.got[0])} остался один — НЕ оплачивай.`);
    return { ok: false, single: d.got };
  } finally { await b.close(); }
}

function selftest() {
  const A = require('assert');
  A.equal(pick([], 18), 18); A.equal(pick([], 20), 20); A.equal(pick([], 21), null); A.equal(pick([20], 21), 21); A.equal(pick([18], 19), 19);
  A.ok(paired([18, 19])); A.ok(!paired([18, 20])); A.ok(paired([18, 20, 21]));
  A.ok(hope([18], 18)); A.ok(hope([], 19)); A.ok(!hope([], 20)); A.ok(hope([20], 20)); A.ok(!hope([18], 21));
  A.equal(planyoDate('2026-10-22'), 'Oct 22, 2026');
  const u = upcoming('Upcoming reservations\nBooking ID\tDate\tTime\tResource\tStatus\n20500001\tOct 22, 2026\t09:00 pm\tOutdoor Tennis Courts\tConfirmed\n20500000\tOct 22, 2026\t08:00 pm\tOutdoor Tennis Courts\tConfirmed\n20500002\tOct 25, 2026\t12:00 pm\tOutdoor Tennis Courts\tConfirmed\nCancelled reservations\n18968185\tFeb 01, 2026\t09:00 pm\tOutdoor Tennis Courts\tCancelled');
  A.deepEqual(u.map((g) => [g.date, g.start, g.end, g.ids.length]), [['2026-10-22', 20, 22, 2], ['2026-10-25', 12, 13, 1]]);
  console.log('selftest ok');
}

const arg = process.argv.slice(2);
(async () => {
  if (arg.includes('--selftest')) return selftest();
  if (arg.includes('--check')) return check(arg[arg.indexOf('--check') + 1] || plus(iso(doha()), 7));
  if (arg.includes('--run')) return run(arg.includes('--now'));
  if (arg.includes('--sync')) return sync();
  if (arg.includes('--book')) return console.log('RESULT ' + JSON.stringify(await bookNow(arg[arg.indexOf('--book') + 1], arg.includes('--dry'))));
  console.log('usage: --run [--now] | --sync | --check [ГГГГ-ММ-ДД] | --selftest');
})().catch((e) => { log('FATAL', e.message); notify('🎾 UDST: агент упал', e.message.slice(0, 200)); process.exitCode = 1; });
