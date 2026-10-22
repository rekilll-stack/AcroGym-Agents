#!/usr/bin/env node
/* Теннис-агент (владелец 15.10.2026): бронь корта UDC (The Pearl) письмом с rekilll@ на ittisal@udcqatar.com.
   Правила из переписки 2023–2026: письмо ровно в 00:00:00 по Дохе, дата в письме = +7 дней, тема «tennis court», вс–чт;
   по понедельникам ещё утро 7–9 (владелец 15.10). Цель — хотя бы час в окне (вечер 18–21, утро 7–9), любой корт: Giardino (GV) или Family Park (Costa Malaz).
   --send     крон 23:59 сб–ср: ждёт 00:00:00.2 и шлёт заявки;  --dry — только напечатать
   --watch    крон каждые 2 мин: ответы UDC → подтверждение: событие в календарь rekilll + Джарвис; вопрос/предложение: ответ ИИ в окне; прочее — владельцу
   --add '<json>' бронь, сделанная снаружи (ChatGPT → POST acrogym.org/schedule/api/tennis): tennis.json + календарь + Джарвис
   --selftest проверки дат, шаблона, разбора подтверждений и сторожа времени (без сети) */
require('dotenv').config({ path: __dirname + '/../../.env' });
const fs = require('fs');
const gmail = require('../mail-digest/gmail.js').accounts.rekilll;
const W = require('./week.js'); /* правила недели: не больше 2 вечеров, лучшие вс/пн/ср, приоритет Pearl */

const TO = 'ittisal@udcqatar.com', FROM = 'Kirill Bazhanov <rekilll@gmail.com>', SUBJECT = 'tennis court';
const STATE = __dirname + '/../../data/tennis.json', CAL_CRED = '/home/admin/mcp-servers/gmail/credentials-cal.json';
const WIN = { evening: [18, 21], morning: [7, 9] };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const BODY = {
  evening: (d) => `Hello team,\n\nI want to book a Tennis court on ${d} from 6 to 8 pm or from 7 to 9 pm at\nGiardino or Family Park\nMy phone number is 33409895.\n\nMany thanks in advance!\n\nRegards,\nKirill Bazhanov`,
  morning: (d) => `Hello team,\n\nI want to book a Tennis court on ${d} for one hour from 7 to 8 am (or 8 to 9 am) at\nGiardino or Family Park\nMy phone number is 33409895.\n\nMany thanks in advance!\n\nRegards,\nKirill Bazhanov`,
};

const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { sent: [], seen: {}, replies: {}, booked: [] }; } };
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 1));
const log = (...a) => console.log(new Date().toISOString(), ...a);
/* дата по Дохе (UTC+3, без перехода на летнее время) */
const doha = (ms = Date.now()) => new Date(ms + 3 * 3600e3);
const iso = (d) => d.toISOString().slice(0, 10);
const plus = (isoDay, n) => iso(new Date(Date.parse(isoDay + 'T00:00:00Z') + n * 864e5));
const human = (isoDay) => { const d = new Date(isoDay + 'T00:00:00Z'); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; };
const dow = (isoDay) => new Date(isoDay + 'T00:00:00Z').getUTCDay(); /* 0 вс … 6 сб */
/** заявки дня отправки: вс–чт — вечер на +7; понедельник — ещё утро */
function plan(today) {
  const w = dow(today); if (w === 5 || w === 6) return [];
  const date = plus(today, 7);
  return [...(w === 1 ? [{ kind: 'morning', date }] : []), { kind: 'evening', date }];
}

function notify(title, body) { /* в Джарвис: таблица notif почтового секретаря → алерты моста → пуш */
  try {
    const db = new (require('better-sqlite3'))(__dirname + '/../../data/mail.db');
    db.prepare('INSERT OR REPLACE INTO notif(id,title,body,at) VALUES(?,?,?,?)').run('tennis-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), title, body, new Date().toISOString());
    db.close();
  } catch (e) { log('notif ERR', e.message); }
}
async function alarm(text) { notify('🎾 Теннис: нужна помощь', text); try { const { sendToOwner } = require('../../shared/telegram.js'); await sendToOwner('🎾 ' + text, { parse_mode: undefined }); } catch (_) {} }

/* дата в теме: Gmail склеивал одинаковые темы разных дней в одну цепочку (6 из 126 в истории) — ответ должен однозначно относиться к дню */
const subj = (j) => `${SUBJECT} ${human(j.date)}${j.kind === 'morning' ? ' morning' : ''}`;
const b64 = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const mime = (h, text) => Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n' + text;

async function send(dry) {
  await gmail.list('in:sent', 1); /* токен заранее — в 00:00 отправка без лишней секунды */
  let now = Date.now(); const toMid = 864e5 - ((now + 3 * 3600e3) % 864e5);
  if (toMid < 10 * 60e3) { log('жду полночь', Math.round(toMid / 1000), 'с'); await new Promise((r) => setTimeout(r, toMid + 200)); now = Date.now(); }
  const today = iso(doha(now)), st = load(), jobs = plan(today);
  if (!jobs.length) return log('выходной', today);
  for (const j of jobs) {
    if (st.sent.some((x) => x.date === j.date && x.kind === j.kind)) { log('уже отправлено', j.kind, j.date); continue; }
    if (st.booked.some((x) => x.date === j.date && x.start >= WIN[j.kind][0] && x.end <= WIN[j.kind][1])) { log('уже забронировано', j.kind, j.date); continue; } /* например, через ChatGPT — второй брони не просим */
    if (j.kind === 'evening' && !W.want(j.date, W.games(j.date, st))) { log('правила недели: вечер не прошу', j.date); continue; }
    const text = BODY[j.kind](human(j.date)), raw = mime({ From: FROM, To: TO, Subject: subj(j) }, text);
    if (dry) { console.log('--- ' + j.kind + ' ' + j.date + '\n' + text); continue; }
    try {
      const r = await gmail.send(b64(raw));
      st.sent.push({ ...j, id: r.id, thread: r.threadId, at: new Date().toISOString() }); save(st);
      log('отправлено', j.kind, j.date, r.id);
      notify('🎾 Заявка на корт отправлена', `${human(j.date)} ${j.kind === 'morning' ? 'утро, 1 час (7–8 или 8–9)' : '18–21'} · жду ответ UDC`);
    } catch (e) { log('send ERR', e.message); await alarm(`не ушла заявка на ${human(j.date)} (${j.kind}): ${e.message.slice(0, 120)}`); }
  }
}

/* ── ответы ── */
const clean = (s) => String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/P \{margin[^}]*\}/g, '').replace(/[​\s]+/g, ' ').trim();
/** только новое письмо, без цитаты прошлых (21.10: в извинении UDC цитата старой брони 07:00-08:00 читалась как новая) */
const fresh = (s) => clean(s).split(/\s\*?From:\*?\s.{0,120}?\*?Sent:\*?|\sOn \w{3},? .{0,80}? wrote:/)[0];
/** подтверждения: «Booking Date : 24/02/2026 Time Slot : 19:00-20:00 … Location : Costa Malaz» (по блоку на час) */
function confirmations(text) {
  const out = [], re = /Booking Date\s*:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})(.*?)Time Slot\s*:\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})(.*?)(?=Booking Date|$)/gi;
  for (const m of fresh(text).matchAll(re)) {
    const loc = (m[9].match(/Location\s*:\s*([A-Za-z][A-Za-z ]*?)(?=\s+(?:Regards|Amenity|&|Booking|Ittisal|Please|Kindly|$))/i) || [])[1] || '';
    out.push({ date: `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`, start: +m[5] + m[6] / 60, end: +m[7] + m[8] / 60, loc: loc.trim() });
  }
  /* соседние часы одного корта — одно событие */
  return out.sort((a, b) => (a.date + a.loc + a.start).localeCompare(b.date + b.loc + b.start)).reduce((acc, x) => { const p = acc[acc.length - 1]; if (p && p.date === x.date && p.loc === x.loc && p.end === x.start) p.end = x.end; else acc.push({ ...x }); return acc; }, []);
}
/** интервалы времени в тексте («7 to 8 pm», «19:00-21:00») → [{s, e}] в часах 0–24 */
function ranges(text, kind) {
  const re = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|till|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi;
  const h24 = (h, ap) => { h = +h; if (/pm/i.test(ap || '')) return h < 12 ? h + 12 : h; if (/am/i.test(ap || '')) return h === 12 ? 0 : h; return kind === 'evening' && h < 12 ? h + 12 : h; };
  return [...String(text).matchAll(re)].map((m) => { const ap = m[3] || m[6]; return { s: h24(m[1], m[3] || ap) + (+m[2] || 0) / 60, e: h24(m[4], m[6] || ap) + (+m[5] || 0) / 60 }; });
}
/** сторож: все интервалы времени в ответе — внутри окна; иначе ответ не шлём */
const timesOk = (reply, kind) => ranges(reply, kind).every((r) => r.s >= WIN[kind][0] && r.e <= WIN[kind][1] && r.e > r.s);
/** ошибка UDC (владелец 21.10: просили 7–8 pm, забронировали 07:00–08:00): подтверждение вне времени из последнего письма Kirill → уточняем сразу.
    В последнем письме нет времени (владелец пишет своё) — не судим. */
function mistakes(conf, askedText, req) {
  const r = ranges(fresh(askedText), req.kind); if (!r.length) return [];
  const s = Math.min(...r.map((x) => x.s)), e = Math.max(...r.map((x) => x.e));
  return conf.filter((c) => c.date !== req.date || c.start < s || c.end > e).map((c) => ({ ...c, asked: { s, e } }));
}
const hhmm = (x) => String(Math.floor(x)).padStart(2, '0') + ':' + String(Math.round((x % 1) * 60)).padStart(2, '0');
const ampm = (x) => { const h = Math.floor(x), m = Math.round((x % 1) * 60); return (h % 12 || 12) + (m ? ':' + String(m).padStart(2, '0') : '') + (h < 12 ? ' am' : ' pm'); };
async function replyUdc(st, id, m, thread, text) {
  const h = await gmail.getHeaders(id), mid = h['message-id'] || '';
  const raw = mime({ From: FROM, To: TO, Subject: 'Re: ' + String(m.subject || SUBJECT).replace(/^(re:\s*)+/i, ''), ...(mid ? { 'In-Reply-To': mid, References: mid } : {}) }, text);
  await gmail.send(b64(raw), thread); st.replies[thread] = (st.replies[thread] || 0) + 1; save(st);
}

async function calendar(ev) { /* событие в календарь rekilll; нет доступа — копим в pending */
  if (!fs.existsSync(CAL_CRED)) return null;
  const t = { access_token: await calToken() };
  const loc = /costa|family/i.test(ev.loc) ? 'Family Park (Costa Malaz), The Pearl' : /gv|giardino/i.test(ev.loc) ? 'Giardino Village, The Pearl' : (ev.loc || 'The Pearl');
  const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', headers: { Authorization: 'Bearer ' + t.access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: '🎾 Теннис', location: loc, description: 'Бронь UDC (ittisal@udcqatar.com), поставил теннис-агент', start: { dateTime: `${ev.date}T${hhmm(ev.start)}:00`, timeZone: 'Asia/Qatar' }, end: { dateTime: `${ev.date}T${hhmm(ev.end)}:00`, timeZone: 'Asia/Qatar' } }) });
  if (!r.ok) throw new Error('calendar ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return (await r.json()).id;
}

async function calToken() {
  const c = JSON.parse(fs.readFileSync(CAL_CRED, 'utf8'));
  return (await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: 'refresh_token' }) })).json()).access_token;
}
/** правила недели (week.js): лишнее отменяем — UDC письмом об отмене + убираем из календаря; UDST просим не оплачивать */
async function reconcile(dry) {
  const st = load(), us = W.load('udst.json', {}), today = iso(doha()), weeks = new Map();
  for (const b of st.booked) if (b.start >= 17 && b.date >= today) weeks.set(W.weekOf(b.date), b.date);
  for (const day of weeks.values()) for (const g of W.extra(W.games(day, st, us))) {
    if (g.date < today || g.ref.cancelFailed) continue;
    const b = g.ref, what = g.src === 'udc' ? `${human(b.date)} ${hhmm(b.start)}–${hhmm(b.end)}${b.loc ? ' ' + b.loc : ''}` : `${human(g.date)} UDST`;
    if (dry) { console.log('по правилам недели отменил бы:', what); continue; }
    if (g.src === 'udst') { (st.udstDropped ||= {})[g.date] = new Date().toISOString(); save(st); notify('🎾 UDST: не оплачивай', `${what}: в этот день есть Pearl или на неделе уже 2 вечера в лучшие дни. Если уже оплачено — отмени в кабинете UDST.`); continue; }
    const text = `Hello team,\n\nPlease cancel my Tennis court booking on ${human(b.date)} from ${hhmm(b.start)} to ${hhmm(b.end)}${b.loc ? ' at ' + b.loc : ''}.\n\nMany thanks!\n\nRegards,\nKirill Bazhanov`;
    try { await gmail.send(b64(mime({ From: FROM, To: TO, Subject: `cancel ${SUBJECT} ${human(b.date)}` }, text))); }
    catch (e) { b.cancelFailed = true; save(st); await alarm(`не ушло письмо UDC об отмене ${what}: ${e.message.slice(0, 120)} — отмени сам`); continue; }
    st.booked.splice(st.booked.indexOf(b), 1); (st.cancelled ||= []).push({ ...b, cancelled: new Date().toISOString() }); save(st);
    if (b.event) try { await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events/' + b.event, { method: 'DELETE', headers: { Authorization: 'Bearer ' + await calToken() } }); } catch (e) { log('calendar del ERR', e.message); }
    log('отмена по правилам недели', what);
    notify('🎾 Отменил корт', `${what}: лишний по правилам недели (не больше 3 вечеров и не 3 подряд) — написал UDC об отмене, из календаря убрал`);
  }
}

async function decide(req, msg, thread) {
  const { generateText } = require('../content-bot/llm.js'), [a, b] = WIN[req.kind];
  const sys = `You reply on behalf of Kirill Bazhanov to the UDC (The Pearl, Doha) community team about a tennis court booking.
Goal: get AT LEAST ONE hour booked on ${human(req.date)} fully inside ${a}:00–${b}:00 (${req.kind === 'evening' ? '6–9 pm' : '7–9 am'}), at Giardino (GV) or Family Park (Costa Malaz) — either court is fine, one hour is fine.
Rules: if they offer any slot inside that window — accept it ("Yes, please book …"). If they say the requested time is taken or ask what time — ask for any available hour between ${req.kind === 'evening' ? '6 pm and 9 pm' : '7 am and 9 am'} on either court. If nothing inside the window is available — do not reply (action none). If they ask for documents (QID, lease), payment, ID, or anything not about choosing a time/court — action escalate. If they confirm or say it is already booked — action none. Never accept times outside the window, never cancel anything, never add information except the name and phone 33409895.
UDC rule (owner 20.10): MORNING courts are complimentary — max ONE hour per day and max TWO hours per week, not on the same day; so in the morning ask for / accept exactly one hour (7–8 or 8–9 am). Weekday EVENINGS can be booked for 2 hours.
Style: very short and polite, like Kirill writes: "Hello, Please book 7 to 8 pm at Family Park. Thanks! Regards, Kirill Bazhanov".
Return JSON only: {"action":"reply"|"none"|"escalate","reply":"<email text or empty>","note_ru":"<one line in Russian for Kirill: what they wrote and what you did>"}`;
  const user = `Our request: ${human(req.date)}, ${req.kind}.\nThread so far (oldest first):\n${thread.map((m) => `[${m.me ? 'Kirill' : 'UDC'}] ${clean(m.body).slice(0, 600)}`).join('\n')}\n\nNEW message from UDC:\n${clean(msg.body).slice(0, 1500)}`;
  const raw = await generateText({ system: sys, user, maxTokens: 600 });
  const j = JSON.parse(String(raw).slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  if (!['reply', 'none', 'escalate'].includes(j.action)) throw new Error('bad action ' + j.action);
  return j;
}

async function watch(dry) {
  const st = load(), ids = await gmail.list('from:udcqatar.com newer_than:14d', 30);
  for (const id of ids.reverse()) {
    if (st.seen[id]) continue;
    const m = await gmail.get(id, 6000), thread = m.threadIdRaw;
    if (/cancel/i.test(m.subject || '')) { if (!dry) { notify('🎾 UDC об отмене', clean(m.body).slice(0, 200)); st.seen[id] = 1; save(st); } continue; } /* ответ на наше письмо об отмене — заново не бронируем */
    const conf = confirmations(m.body), key = (c) => `${c.date} ${c.start}-${c.end} ${c.loc}`;
    const mine = st.sent.filter((x) => x.thread === thread), req = mine.find((x) => (m.subject || '').includes(subj(x))) || mine[mine.length - 1]
      || st.sent.find((x) => conf.some((c) => c.date === x.date)); /* подтверждение отдельным письмом, не в цепочке — по дате брони */
    if (!req) { st.seen[id] = 1; save(st); continue; } /* не наша заявка (старые письма, рассылки) */
    log('ответ UDC', id, req.date, req.kind, conf.length ? 'подтверждение ' + conf.map(key).join('; ') : clean(m.body).slice(0, 100));
    if (dry) { console.log({ id, req, conf, body: clean(m.body).slice(0, 300) }); continue; }
    const hist = [];
    for (const x of (await gmail.list(`in:anywhere subject:"${SUBJECT}" newer_than:14d`, 20)).reverse()) { const g = await gmail.get(x, 1500); if (g.threadIdRaw === thread && x !== id) hist.push({ me: /rekilll/i.test(g.from), body: g.body }); }
    const lastMe = [...hist].reverse().find((h) => h.me), bad = mistakes(conf, lastMe ? lastMe.body : BODY[req.kind](human(req.date)), req);
    const good = conf.filter((c) => !bad.some((x) => key(x) === key(c))), [a, b] = WIN[req.kind], inWin = good.filter((c) => c.start >= a && c.end <= b);
    if (bad.length) { /* не то время — в календарь не ставим, сразу просим исправить */
      const c = bad[0], what = `${human(c.date)} ${hhmm(c.start)}–${hhmm(c.end)}`;
      const asked = c.asked.e - c.asked.s > 1 ? `a time between ${ampm(c.asked.s)} and ${ampm(c.asked.e)}` : `${ampm(c.asked.s)} to ${ampm(c.asked.e)}`;
      if ((st.replies[thread] || 0) < 3) {
        await replyUdc(st, id, m, thread, `Hello,\n\nI think there is a mistake with the time: you booked ${what}, but I asked for ${asked} on ${human(req.date)}.\nCould you please correct the booking to ${asked}?\n\nThanks!\n\nRegards,\nKirill Bazhanov`);
        log('ошибка UDC', what, '→ просил', asked, '— написал исправить');
        await alarm(`UDC ошибся: забронировал ${what}, а просили ${asked} — сразу написал им исправить, в календарь не ставил`);
      } else await alarm(`UDC ошибся: забронировал ${what}, а просили ${asked}; автоответов в цепочке уже 3 — ответь сам`);
    }
    if (good.length) {
      for (const c of good) {
        if ([...st.booked, ...(st.cancelled || [])].some((x) => key(x) === key(c))) continue;
        let ev = null; try { ev = await calendar(c); } catch (e) { log('calendar ERR', e.message); }
        st.booked.push({ ...c, event: ev, pending: !ev }); save(st);
        notify('🎾 Корт забронирован', `${human(c.date)} ${hhmm(c.start)}–${hhmm(c.end)} · ${c.loc || 'корт'}${ev ? ' · в календаре' : ''}`);
      }
    }
    if (bad.length || inWin.length) { st.seen[id] = 1; save(st); continue; } /* ошибку уже уточнили / цель достигнута — отвечать незачем */
    let d; try { d = await decide(req, m, hist).catch(async (e1) => { log('decide retry', e1.message); await new Promise((r) => setTimeout(r, 20000)); return decide(req, m, hist); }); } catch (e) { log('decide ERR', e.message); await alarm(`не понял ответ UDC про ${human(req.date)}: «${clean(m.body).slice(0, 160)}» — ответь сам`); st.seen[id] = 1; save(st); continue; }
    if (d.action === 'reply' && ((st.replies[thread] || 0) >= 3 || !timesOk(d.reply, req.kind))) d = { ...d, action: 'escalate', note_ru: (d.note_ru || '') + ' (сторож: ответ вне окна или 3+ ответа в цепочке)' };
    if (d.action === 'reply') {
      await replyUdc(st, id, m, thread, d.reply);
      notify('🎾 Ответил UDC', `${human(req.date)}: ${d.note_ru} → «${d.reply.slice(0, 120)}»`);
    } else if (d.action === 'escalate') await alarm(`${human(req.date)}: ${d.note_ru} — UDC: «${clean(m.body).slice(0, 200)}»`);
    else notify('🎾 Ответ UDC', `${human(req.date)}: ${d.note_ru}`);
    st.seen[id] = 1; save(st);
  }
  for (const c of st.booked.filter((x) => x.pending)) { try { const ev = await calendar(c); if (ev) { c.event = ev; c.pending = false; save(st); } } catch (e) { log('calendar ERR', e.message); break; } }
  await reconcile(dry);
}

/** бронь снаружи: {date:'ГГГГ-ММ-ДД', from:'ЧЧ:ММ', to:'ЧЧ:ММ', court?} → запись как у подтверждения UDC, иначе null */
function parseBooking(j) {
  const h = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] + m[2] / 60 : NaN; };
  const c = { date: String(j.date || '').trim(), start: h(j.from), end: h(j.to), loc: String(j.court || '').replace(/[^\p{L}\p{N} ()#.,-]/gu, '').trim().slice(0, 60), src: j.src === 'udc-api' ? 'udc-api' : 'chatgpt' };
  return /^\d{4}-\d\d-\d\d$/.test(c.date) && !isNaN(Date.parse(c.date)) && c.end > c.start ? c : null;
}
async function add(j) {
  const c = parseBooking(j || {});
  if (!c) return { ok: false, err: 'need date YYYY-MM-DD, from and to HH:MM (to after from), court optional' };
  const ahead = (Date.parse(c.date) - Date.parse(iso(doha()))) / 864e5;
  if (ahead < -1 || ahead > 60) return { ok: false, err: 'date must be from yesterday to 60 days ahead' }; /* мусор и опечатки в календарь не пускаем */
  const st = load(), key = (x) => `${x.date} ${x.start}-${x.end} ${x.loc}`;
  if ([...st.booked, ...(st.cancelled || [])].some((x) => key(x) === key(c))) return { ok: true, duplicate: true };
  let ev = null; try { ev = await calendar(c); } catch (e) { log('calendar ERR', e.message); }
  st.booked.push({ ...c, event: ev, pending: !ev }); save(st); /* календарь не ответил — --watch доставит позже */
  notify('🎾 Корт забронирован', `${human(c.date)} ${hhmm(c.start)}–${hhmm(c.end)} · ${c.loc || 'корт'} · через ${c.src === 'udc-api' ? 'API UDC' : 'ChatGPT'}${ev ? ' · в календаре' : ''}`);
  log('add', key(c), ev ? 'в календаре' : 'календарь позже');
  return { ok: true, calendar: !!ev };
}

function selftest() {
  const A = require('assert');
  A.deepStrictEqual(plan('2026-10-18'), [{ kind: 'evening', date: '2026-10-25' }]); /* вс */
  A.deepStrictEqual(plan('2026-10-19'), [{ kind: 'morning', date: '2026-10-26' }, { kind: 'evening', date: '2026-10-26' }]); /* пн: утро + вечер */
  A.deepStrictEqual(plan('2026-10-16'), []); A.deepStrictEqual(plan('2026-10-17'), []); /* пт, сб */
  A.strictEqual(plus('2026-12-28', 7), '2027-01-04'); A.strictEqual(human('2026-10-22'), '22 October');
  A.strictEqual(iso(doha(Date.parse('2026-10-15T21:00:00.200Z'))), '2026-10-16'); /* 00:00:00.2 Дохи — уже новый день */
  A.match(BODY.evening(human('2026-10-22')), /book a Tennis court on 22 October from 6 to 8 pm/);
  A.strictEqual(subj({ kind: 'morning', date: '2026-10-26' }), 'tennis court 26 October morning');
  const c = confirmations('P {margin-top:0;} Dear Resident, Amenity : Tennis Booking Date : 24/02/2026 Time Slot : 19:00-20:00 Booking Charge : 75.00 QAR Location : Costa Malaz &amp; Amenity : Tennis Booking Date : 24/02/2026 Time Slot : 20:00-21:00 Booking Charge : 75.00 QAR Location :&nbsp;Costa Malaz Regards, Ittisal');
  A.deepStrictEqual(c, [{ date: '2026-02-24', start: 19, end: 21, loc: 'Costa Malaz' }]);
  A.strictEqual(confirmations('Booking Date : 22/04/2025 Time Slot : 07:00-08:00 Location : Costa Malaz Regards')[0].start, 7);
  A.ok(timesOk('Yes, please book 7 to 8 pm at Family Park.', 'evening')); A.ok(timesOk('Please book 19:00-21:00', 'evening'));
  A.ok(!timesOk('Please book 5 to 6 pm', 'evening')); A.ok(!timesOk('Yes, 8 to 10 pm is fine', 'evening'));
  A.ok(timesOk('Please book 7 to 8 am', 'morning')); A.ok(!timesOk('Please book 9 to 10 am', 'morning'));
  A.ok(timesOk('Please book any available hour between 6 pm and 9 pm on 22 October.', 'evening'));
  /* 21.10: новый формат с «Please pay», цитата старой брони в извинении, просили 7–8 pm — дали 07:00–08:00 */
  A.strictEqual(confirmations('Booking Date : 28/10/2026 Time Slot : 18:00-19:00 Booking Charge : 75.00 QAR Location : Costa Malaz Please pay the booking fee within 24 hours')[0].loc, 'Costa Malaz');
  A.deepStrictEqual(confirmations('Dear Kirill, Please accept our sincere apologies … 6:00 PM to 7:00 PM … Ittisal From: Kirill Bazhanov &lt;rekilll@gmail.com&gt; Sent: Wednesday, October 21, 2026 6:21 AM … Booking Date : 28/10/2026 Time Slot : 07:00-08:00 Location : Costa Malaz'), []);
  const r28 = { kind: 'evening', date: '2026-10-28' }, am = confirmations('Booking Date : 28/10/2026 Time Slot : 07:00-08:00 Location : Costa Malaz Regards');
  A.deepStrictEqual(mistakes(am, 'Hello, Please book 7 to 8 pm on 28 October at Family Park. Thanks!', r28).map((x) => x.asked), [{ s: 19, e: 20 }]);
  A.deepStrictEqual(mistakes(confirmations('Booking Date : 28/10/2026 Time Slot : 19:00-20:00 Location : Costa Malaz Regards'), 'Please book 7 to 8 pm', r28), []);
  A.deepStrictEqual(mistakes(confirmations('Booking Date : 28/10/2026 Time Slot : 18:00-19:00 Location : Costa Malaz Regards'), BODY.evening('28 October'), r28), []);
  A.deepStrictEqual(mistakes(am, 'I have a booking on 26th and it is paid, please change it to 28.', r28), []); /* своё письмо владельца без времени — не судим */
  A.strictEqual(ampm(19) + ' to ' + ampm(20), '7 pm to 8 pm');
  A.deepStrictEqual(parseBooking({ date: '2026-10-22', from: '20:00', to: '22:00', court: 'Family Park' }), { date: '2026-10-22', start: 20, end: 22, loc: 'Family Park', src: 'chatgpt' });
  A.strictEqual(parseBooking({ date: '22.10.2026', from: '20:00', to: '22:00' }), null);
  A.strictEqual(parseBooking({ date: '2026-10-22', from: '21:00', to: '20:00' }), null);
  console.log('selftest ok');
}

const arg = process.argv.slice(2), dry = arg.includes('--dry');
(async () => {
  if (arg.includes('--selftest')) return selftest();
  if (arg.includes('--send')) return send(dry);
  if (arg.includes('--watch')) return watch(dry);
  if (arg.includes('--try')) { const kind = arg.includes('--morning') ? 'morning' : 'evening', d = await decide({ kind, date: plus(iso(doha()), 7) }, { body: arg[arg.indexOf('--try') + 1] }, []); console.log(d, d.action === 'reply' ? 'timesOk=' + timesOk(d.reply, kind) : ''); return; } /* проверка решения ИИ на тексте письма */
  if (arg.includes('--add')) { let j = null; try { j = JSON.parse(arg[arg.indexOf('--add') + 1]); } catch (_) {} return console.log(JSON.stringify(await add(j))); }
  console.log('usage: --send [--dry] | --watch [--dry] | --add <json> | --selftest');
})().catch(async (e) => {
  log('FATAL', e.message); process.exitCode = 1;
  /* разовые сбои Google/сети (16.10: token 500 internal_failure) не будят владельца — тревога, если 3 таких за 10 мин (крон каждые 2 мин) */
  if (/\b5\d\d\b|ECONN|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i.test(e.message)) {
    const F = __dirname + '/../../data/tennis-transient.json', now = Date.now(); let t = []; try { t = JSON.parse(fs.readFileSync(F, 'utf8')); } catch (_) {}
    t = t.filter((x) => now - x < 10 * 60e3).concat(now); fs.writeFileSync(F, JSON.stringify(t));
    if (t.length !== 3) return log('временный сбой', t.length + '/3 за 10 мин — без тревоги');
  }
  await alarm('агент упал: ' + e.message.slice(0, 160));
});
