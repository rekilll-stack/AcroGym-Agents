'use strict';
/**
 * mail-digest — «секретарь почты» rekilll@gmail.com.
 *   node index.js digest   — разбор писем за сутки → Telegram владельцу (крон 07:30)
 *   node index.js urgent   — проверка новых писем на срочное (крон каждый час)
 *   node index.js remind   — напоминания о событиях: за 3 дня, за 1 день, в день события 06:00 (крон 06:00 и 09:00)
 * Только чтение: ничего не отвечает и не удаляет.
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const Database = require('better-sqlite3');
const gmail = require('./gmail.js');
const { pdfText } = require('./attach.js');
const { generateText } = require('../content-bot/llm.js') /* подписочный шим: разбор почты не должен жечь платный API (правило владельца) */;
const { sendToOwner, escapeMd } = require('../../shared/telegram.js');
const { createLogger } = require('../../shared/logger.js');

const log = createLogger('mail-digest');
const DB = new Database(__dirname + '/../../data/mail.db');
DB.exec(`
  CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, ts INTEGER, cat TEXT, urgent INTEGER, digested INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS mail (
    id TEXT PRIMARY KEY, ts INTEGER, cat TEXT, urgent INTEGER, action TEXT, deadline TEXT,
    from_name TEXT, from_addr TEXT, subject TEXT, summary TEXT, detail TEXT, links TEXT, pushed INTEGER DEFAULT 0);
  CREATE INDEX IF NOT EXISTS mail_ts ON mail(ts);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, msg_id TEXT, title TEXT, date TEXT, time TEXT,
    who TEXT, note TEXT, created_at TEXT, r3 INTEGER DEFAULT 0, r1 INTEGER DEFAULT 0, r0 INTEGER DEFAULT 0);
  CREATE INDEX IF NOT EXISTS ev_date ON events(date);
  CREATE TABLE IF NOT EXISTS notif (id TEXT PRIMARY KEY, title TEXT, body TEXT, at TEXT);
`);
try { DB.exec("ALTER TABLE mail ADD COLUMN acc TEXT DEFAULT 'rekilll'"); } catch (_) {} /* миграция 27.08: второй ящик info@ */
try { DB.exec('ALTER TABLE mail ADD COLUMN files TEXT'); } catch (_) {} /* вложения: имена файлов */

/* Владелец (27.08): следим ТОЛЬКО за тремя отправителями — Queens, Lagoona (Darwish), CBQ.
   Остальная почта не читается вообще (ни LLM, ни логов). */
const WATCH = '(from:queensqatar.school OR from:openapply.com OR from:darwishholding.com OR from:lagoonamall.com OR from:cbq.com.qa)';
const NOISE = /temu|talabat|qatarliving|feverup|headout|opensea|kucoin|rustore|acehotel|aliexpress|booking\.com|noreply-accounts@google|no-reply@accounts\.google|linkedin|facebookmail|instagram/i;
const qatarNow = () => new Date(Date.now() + 3 * 3600e3);
const iso = (d) => d.toISOString().slice(0, 10);

/** Список будущих событий для промпта — чтобы перенос/отмена обновляли запись, а не плодили дубли (06.09: три «тестирования Матвея»). */
function existingEvents() {
  try { return DB.prepare("SELECT id, date, time, title FROM events WHERE date >= date('now', '-7 day') ORDER BY date LIMIT 40").all().map((e) => `${e.id} · ${e.date}${e.time ? ' ' + e.time : ''} · ${e.title}`).join('\n') || '—'; } catch (_) { return '—'; }
}
/** Один LLM-проход по пачке писем: категория, суть, срочность, события. */
async function classify(mails, acc = 'rekilll') {
  const list = mails.map((m, i) => `#${i + 1}
FROM: ${m.from}
SUBJ: ${m.subject}
DATE: ${m.date}
FILES: ${(m.files || []).join(', ') || '—'}
TEXT: ${m.body.replace(/\s+/g, ' ').slice(0, 2600)}${(m.attachTexts || []).map((a) => `\nATTACHMENT «${a.f}»: ${a.t.slice(0, 1200)}`).join('')}`).join('\n\n');
  const prompt = `Ты — личный секретарь Кирилла (владелец детского гимнастического центра AcroGym, Lagoona Mall, Доха). Разбери входящие письма.

Для КАЖДОГО письма верни объект:
{"n":<номер>,"cat":"mall|school|bank|other|noise","who":"<имя и роль отправителя, напр. 'Charbel Dagher, маркетинг Lagoona'>",
 "ru":"<суть ОДНОЙ строкой>",
 "detail":["<подробный пункт 1: что именно пишут, цифры, даты, требования>","<пункт 2>","<пункт 3>"],
 "links":[{"t":"<что это за ссылка>","u":"<url>"}],
 "action":"reply|pay|read|none","deadline":"YYYY-MM-DD или null","urgent":true|false,
 "event":{"title":"<что за событие>","date":"YYYY-MM-DD","time":"HH:MM 24ч или null","who":"<кто организует>","status":"confirmed|proposed|cancelled","replaces":<id из списка УЖЕ ЗАПИСАННЫХ событий, если письмо переносит/уточняет/отменяет именно его, иначе null>} или null}

УЖЕ ЗАПИСАННЫЕ СОБЫТИЯ (id · дата время · название): ${existingEvents()}
- Если письмо ПЕРЕНОСИТ или уточняет одно из них — верни event с новой датой и "replaces":<его id>. Если ОТМЕНЯЕТ — "status":"cancelled" и "replaces".
- Если дата только ПРЕДЛАГАЕТСЯ («можете ли прийти 16-го?») и ещё не подтверждена — "status":"proposed": в календарь такое не попадает, только в суть письма.

Правила:
- cat: school = Queens School / OpenApply (дети Кирилла); mall = Lagoona Mall / Darwish Holding (аренда зала, операционка); bank = Commercial Bank CBQ или QNB; other = всё остальное (госорганы, поставщики, сервисы, личное) — но ТОЛЬКО если требует внимания; noise = реклама, рассылки, автоуведомления сервисов, соцсети.
- ПРИОРИТЕТ: письма Queens и Lagoona/Darwish разбирай МАКСИМАЛЬНО ПОДРОБНО — 3-6 пунктов в detail: кто пишет и в какой роли, что именно сообщают/просят, все даты, суммы, имена, требования, что нужно сделать Кириллу и к какому сроку. Пиши так, чтобы Кириллу НЕ пришлось открывать письмо.
- Если есть вложения (FILES) — упомяни их в detail отдельным пунктом: что за файл и что с ним делать.
- ВРЕМЯ СОБЫТИЯ: копируй как в письме, НЕ додумывай AM/PM. Если написано «7:30» без am/pm — смотри на контекст: «drop your child off», «morning», «coffee morning», «before school» = УТРО (07:30); «evening», «after school», «pick-up» = вечер. Школьные встречи в Катаре обычно утром, до уроков. Сомневаешься — ставь то время, что в письме, и добавь пункт в detail с цитатой строки о времени.
- links: обязательно вынеси ВСЕ полезные ссылки из письма (регистрации, формы, документы, порталы, приглашения) с понятной подписью по-русски. Служебные ссылки (отписка, политика конфиденциальности, иконки соцсетей) НЕ включай.
- Для банка (cat=bank) detail короче: что за операция/уведомление, сумма, счёт, что делать.
- other = всё остальное: включай только если требует решения, оплаты, ответа или несёт новость о деньгах/документах/сроках; иначе noise.
- Для банка: важны выписки с крупными суммами, блокировки, требования документов, истечение карт/чеков. Обычную маркетинговую рассылку CBQ помечай noise.
- urgent=true ТОЛЬКО если: срок ≤48ч, счёт к оплате, штраф/претензия, отказ в услуге, проблема с документами.
- event заполняй, если в письме есть КОНКРЕТНАЯ дата будущего события (школьное мероприятие, встреча, инспекция, дедлайн оплаты, начало учебного года).
- "ru" пиши честно и по делу, без воды. Если письмо — просто реклама, ru = краткое «реклама/рассылка».

${acc === 'info' ? '- ЭТО ЯЩИК info@acrogym.org — входящие бизнеса AcroGym: клиенты и родители, партнёры, поставщики, Lagoona. Письма клиентов/родителей (вопросы о записи, ценах, расписании, пробных) — cat "other", action "reply", urgent при жалобах; разбирай подробно, Кирилл будет отвечать из приложения.' : ''}
Верни ТОЛЬКО JSON-массив, без пояснений.

ПИСЬМА:
${list}`;
  const raw = await generateText({ system: 'You are a precise email triage assistant. Answer with JSON only, no markdown fences.', user: prompt, maxTokens: 8000, model: 'claude-haiku-4-5-20251001' });
  return parseArr(raw);
}
/** Терпимый парсер: вырезает массив, чинит обрыв (берёт целые объекты). */
function parseArr(raw) {
  const t = String(raw).replace(/```json|```/g, '').trim();
  const start = t.indexOf('[');
  if (start < 0) throw new Error('LLM вернул не JSON: ' + t.slice(0, 120));
  const body = t.slice(start);
  try { return JSON.parse(body); } catch (_) {}
  const objs = [];
  let depth = 0, from = -1, inStr = false, esc = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (!depth) from = i; depth++; }
    else if (c === '}') { depth--; if (!depth && from >= 0) { try { objs.push(JSON.parse(body.slice(from, i + 1))); } catch (_) {} from = -1; } }
  }
  if (!objs.length) throw new Error('не удалось разобрать JSON ответа');
  log.warn({ recovered: objs.length }, 'JSON обрезан — восстановлены целые объекты');
  return objs;
}
/** Разбор пачками по 6 писем (подробный разбор длинный). */
async function classifyAll(mails, acc = 'rekilll') {
  const out = [];
  for (let i = 0; i < mails.length; i += 6) {
    const chunk = mails.slice(i, i + 6);
    let res;
    try { res = await classify(chunk, acc); }
    catch (e) { log.warn({ err: e.message }, 'повтор пачки'); res = await classify(chunk, acc); }
    for (const r of res) if (r && r.n >= 1 && r.n <= chunk.length) out.push({ ...r, n: i + r.n });
  }
  return out;
}

const CATS = [['school', '🏫 Queens'], ['mall', '🏢 Lagoona / Darwish'], ['bank', '🏦 CBQ'], ['other', '📌 Прочее важное']];
const ACT = { reply: '✍️ ждёт ответа', pay: '💳 оплатить', read: '👀 к сведению', none: '' };

async function fetchNew(query, cap = 60, gm = gmail) {
  const ids = await gm.list(query, cap);
  const fresh = ids.filter((id) => !DB.prepare('SELECT 1 FROM seen WHERE id=?').get(id));
  const out = [];
  for (const id of fresh) {
    const m = await gm.get(id);
    if (NOISE.test(m.from)) { DB.prepare('INSERT OR IGNORE INTO seen(id,ts,cat,urgent,digested) VALUES(?,?,?,0,1)').run(id, m.ts, 'noise'); continue; }
    /* вложения-PDF приоритетных отправителей читаем (до 3 файлов) — там расписания, гайды, инвойсы */
    if (gm !== gmail || /queensqatar|openapply|darwishholding|lagoonamall|cbq\.com/i.test(m.from)) {
      m.attachTexts = [];
      for (const f2 of (m.files || []).filter((x) => /\.pdf$/i.test(x)).slice(0, 3)) {
        const t = await pdfText(id, f2, gm);
        if (t) m.attachTexts.push({ f: f2, t });
      }
    }
    out.push(m);
  }
  return out;
}

/* ── СТОРОЖ ЗАПИСИ НА CCA (владелец 28.08) ──
   Окно записи на бесплатные школьные CCA ~48 часов, письмо легко утонет в общем разборе.
   Ловим детерминированно (без LLM), раскручиваем sendgrid-редиректы и пушим ссылку сразу. */
const CCA_FROM = /queensqatar\.school|artemis-education|clubsys/i;
const CCA_SIGNUP = /(sign[-\s]?up|signup|registration|register|booking|book your|enrol)/i;
async function unwrap(url) { /* трекер → настоящий адрес */
  try {
    let u = url;
    for (let i = 0; i < 6; i++) {
      const r = await fetch(u, { redirect: 'manual' });
      const loc = r.headers.get('location');
      if (!loc) return u;
      u = loc.startsWith('http') ? loc : new URL(loc, u).href;
    }
    return u;
  } catch (_) { return url; }
}
async function ccaWatch(m) {
  const body = String(m.body || '');
  /* тема письма: школьные CCA ИЛИ внешкольные занятия Artemex (там слова «CCA» может не быть — «After School Activities», «Taster Sessions») */
  const CCA_TOPIC = /\bCCA\b|co-?curricular|after[-\s]school|taster|club\b|activities/i;
  if (!CCA_FROM.test(m.from) || !CCA_TOPIC.test(body) || !CCA_SIGNUP.test(body)) return false;
  const seenKey = 'cca-' + m.id;
  if (DB.prepare('SELECT 1 FROM notif WHERE id=?').get(seenKey)) return false;
  const raw = [...new Set(body.match(/https?:\/\/[^\s<>")]+/g) || [])]
    .filter((u) => !/unsubscribe|privacy|\.(png|jpe?g|gif)/i.test(u));
  const links = [];
  for (const u of raw.slice(0, 18)) { /* школьные письма длинные — ссылка записи бывает далеко не первой */
    const real = await unwrap(u);
    if (/forms\.|clubsys|office|microsoft|google\.com\/forms|typeform/i.test(real)) links.push(real);
  }
  if (!links.length) return false; /* письмо только упоминает CCA, ссылки записи нет — не дёргаем */
  DB.prepare('INSERT OR REPLACE INTO notif(id,title,body,at) VALUES(?,?,?,?)')
    .run(seenKey, '🎯 Открылась запись на CCA', (m.subject || '').slice(0, 70) + ' · ' + links[0], new Date().toISOString());
  DB.prepare('INSERT OR REPLACE INTO mail(id,ts,cat,urgent,action,deadline,from_name,from_addr,subject,summary,detail,links,pushed,acc,files) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)')
    .run(m.id, m.ts, 'school', 1, 'read', null, NAME(m.from).slice(0, 80), ADDR(m.from), (m.subject || '').slice(0, 200),
      'Открылась запись на CCA — окно короткое, записываться сразу', JSON.stringify(['Ссылки записи раскручены из трекера школы']),
      JSON.stringify(links.map((u) => ({ t: 'Запись на CCA', u }))), m.acc || 'rekilll', JSON.stringify(m.files || []));
  log.info({ links }, 'CCA sign-up detected');
  return true;
}

const NAME = (from) => (from.match(/^\s*"?([^"<]+?)"?\s*</) || [])[1] || from.split('@')[0];
const ADDR = (from) => (from.match(/<([^>]+)>/) || [, from])[1];
function saveMail(m, r, acc = 'rekilll') {
  const links = (r.links || []).filter((l) => l && l.u && /^https?:/.test(l.u)).slice(0, 8);
  DB.prepare(`INSERT OR REPLACE INTO mail
    (id, ts, cat, urgent, action, deadline, from_name, from_addr, subject, summary, detail, links, pushed, acc, files)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, COALESCE((SELECT pushed FROM mail WHERE id=?),0), ?, ?)`)
    .run(m.id, m.ts, r.cat, r.urgent ? 1 : 0, r.action || 'none', r.deadline || null,
         (r.who || NAME(m.from)).slice(0, 80), ADDR(m.from), m.subject.slice(0, 200),
         r.ru || '', JSON.stringify(r.detail || []), JSON.stringify(links), m.id, acc, JSON.stringify(m.files || []));
}
/* Одно и то же событие приходит из разных писем и на двух языках («Official opening» / «Официальное
   открытие» / «Начало операций»). Сводим к смысловому ключу: дата + тип. Иначе на одну дату
   накапливается 6 «разных» событий и владелец получает стену одинаковых напоминаний (28.08). */
const EVENT_KIND = [
  ['opening', /open|opening|commencement|launch|открыт|начало операц|запуск/i],
  ['school-year', /school year|term start|учебн(ый|ого) год|начало занятий/i],
  ['photo', /photo|video|shoot|фото|видеосъ|видео-?съ/i],
  ['meeting', /meeting|discussion|call|встреч|обсужден|созвон/i],
  ['maintenance', /cooling|maintenance|disruption|отключен|ремонт|обслуживан/i],
  ['payment', /invoice|payment|счёт|счет|оплат/i],
];
function eventKind(title) {
  const t = String(title || '');
  for (const [k, re] of EVENT_KIND) if (re.test(t)) return k;
  return 'x:' + t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w.length > 3).sort().slice(0, 3).join('-');
}
/** Уже есть такое же событие на эту дату (или на соседнюю — даты в письмах плавают на день)? */
function sameEvent(title, date) {
  const kind = eventKind(title);
  for (const e of DB.prepare("SELECT id, title, date FROM events WHERE date BETWEEN date(?, '-1 day') AND date(?, '+1 day')").all(date, date))
    if (eventKind(e.title) === kind) return e;
  return null;
}
function saveEvents(mails, res) {
  let n = 0;
  for (const r of res) {
    const m = mails[r.n - 1]; if (!m || !r.event || !r.event.date) continue;
    if (r.event.status === 'proposed') continue; /* предложенная, не подтверждённая дата — не событие */
    const old = r.event.replaces && DB.prepare('SELECT id, date, time FROM events WHERE id=?').get(+r.event.replaces);
    if (old) { /* перенос/отмена/уточнение существующего — обновляем запись, напоминания заново */
      if (r.event.status === 'cancelled') { DB.prepare('DELETE FROM events WHERE id=?').run(old.id); continue; }
      const moved = old.date !== r.event.date || (r.event.time && old.time !== r.event.time);
      DB.prepare('UPDATE events SET msg_id=?, title=?, date=?, time=COALESCE(?, time), who=COALESCE(NULLIF(?, \'\'), who), note=?' + (moved ? ', r3=0, r1=0, r0=0' : '') + ' WHERE id=?')
        .run(m.id, r.event.title, r.event.date, r.event.time || null, r.event.who || '', r.ru || '', old.id);
      continue;
    }
    const dup = sameEvent(r.event.title, r.event.date);
    if (dup) { /* то же событие другими словами — уточняем время, если раньше его не было */
      if (r.event.time) DB.prepare('UPDATE events SET time=COALESCE(time, ?) WHERE id=?').run(r.event.time, dup.id);
      continue;
    }
    DB.prepare('INSERT INTO events(msg_id,title,date,time,who,note,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(m.id, r.event.title, r.event.date, r.event.time || null, r.event.who || '', r.ru || '', new Date().toISOString());
    n++;
  }
  return n;
}

/* Оба ящика: rekilll@ (личный) + info@acrogym.org (бизнес, после авторизации) */
function boxes() {
  const b = [['rekilll', gmail]];
  if (gmail.hasInfo()) b.push(['info', gmail.forAcc('info')]);
  return b;
}
async function digest() {
  let total = 0, evN = 0;
  const byCat = {};
  for (const [acc, gm] of boxes()) {
    const mails = await fetchNew('newer_than:' + (process.env.MAIL_WINDOW || '1d') + ' -in:spam -from:me', +(process.env.MAIL_CAP || 60), gm); /* MAIL_WINDOW=8d — добор после простоя */
    if (!mails.length) continue;
    total += mails.length;
    for (const mm of mails) { mm.acc = acc; await ccaWatch(mm); }
    const res = await classifyAll(mails, acc);
    evN += saveEvents(mails, res);
    for (const r of res) {
      const m = mails[r.n - 1]; if (!m) continue;
      DB.prepare('INSERT OR REPLACE INTO seen(id,ts,cat,urgent,digested) VALUES(?,?,?,?,1)').run(m.id, m.ts, r.cat, r.urgent ? 1 : 0);
      if (r.cat === 'noise') continue;
      saveMail(m, r, acc);
      if (r.urgent) DB.prepare('INSERT OR REPLACE INTO notif(id,title,body,at) VALUES(?,?,?,?)')
        .run('mail-' + m.id, '🔴 Срочное письмо', r.ru.slice(0, 140) + (r.deadline ? ' · до ' + r.deadline : ''), new Date().toISOString());
      (byCat[r.cat] = byCat[r.cat] || []).push({ ...r, m });
    }
  }
  if (!total) { log.info('нет новых писем'); return; }
  const mails = { length: total }; /* для лога ниже */
  let out = `📬 *Разбор почты* — ${escapeMd(String(Object.values(byCat).flat().length))} писем\n`;
  const urgent = Object.values(byCat).flat().filter((x) => x.urgent);
  if (urgent.length) {
    out += `\n🔴 *Срочное*\n` + urgent.map((x) => `• ${escapeMd(x.ru)}${x.deadline ? ` \\(до ${escapeMd(x.deadline)}\\)` : ''}`).join('\n') + '\n';
  }
  for (const [key, title] of CATS) {
    let items = (byCat[key] || []).filter((x) => !x.urgent);
    if (key === 'other') items = items.filter((x) => ['reply', 'pay'].includes(x.action) || x.deadline); /* прочее — только с действием */
    if (!items.length) continue;
    out += `\n*${escapeMd(title)}*\n` + items.map((x) => {
      const act = ACT[x.action] || '';
      return `• ${escapeMd(x.ru)}${act ? ` — _${escapeMd(act)}_` : ''}${x.deadline ? ` \\(до ${escapeMd(x.deadline)}\\)` : ''}`;
    }).join('\n') + '\n';
  }
  if (evN) out += `\n📅 Новых событий в календаре: ${evN} \\(напомню за 3 дня, за день и утром\\)\n`;

  /* владелец 27.08: подробности читаем в приложении, телеграм не спамим — тут только лог */
  log.info({ mails: mails.length, events: evN }, 'digest stored (app)');
}

async function urgentCheck() {
  let lastErr = null;
  for (const [acc, gm] of boxes()) {
  try { /* изоляция ящиков: сбой одного не глушит второй (грабля 30-31.08) */
  const mails = await fetchNew('newer_than:2h -in:spam -from:me', 25, gm);
  if (!mails.length) continue;
  for (const mm of mails) { mm.acc = acc; await ccaWatch(mm); }
  const res = await classifyAll(mails, acc);
  try { saveEvents(mails, res); } catch (e) { log.error({ err: e.message }, 'saveEvents failed — письма сохраняем дальше'); }
  for (const r of res) {
    const m = mails[r.n - 1]; if (!m) continue;
    DB.prepare('INSERT OR REPLACE INTO seen(id,ts,cat,urgent,digested) VALUES(?,?,?,?,?)').run(m.id, m.ts, r.cat, r.urgent ? 1 : 0, r.urgent ? 1 : 0);
    if (r.cat !== 'noise') saveMail(m, r, acc);
    if (!r.urgent) continue;
    DB.prepare('INSERT OR REPLACE INTO notif(id,title,body,at) VALUES(?,?,?,?)')
      .run('mail-' + m.id, '🔴 Срочное письмо', r.ru.slice(0, 140) + (r.deadline ? ' · до ' + r.deadline : ''), new Date().toISOString());
    log.info({ from: m.from }, 'urgent notif stored');
  }
  } catch (e) { lastErr = e; log.error({ acc, err: e.message }, 'box failed — продолжаю со следующим'); }
  }
  if (lastErr && boxes().length < 2) throw lastErr; /* единственный ящик упал → пусть сторож увидит */
}

async function remind() {
  const today = iso(qatarNow());
  const d3 = iso(new Date(qatarNow().getTime() + 3 * 864e5));
  const d1 = iso(new Date(qatarNow().getTime() + 864e5));
  const hour = qatarNow().getUTCHours();
  const rows = DB.prepare('SELECT * FROM events WHERE date IN (?,?,?)').all(today, d1, d3);
  const batch = { r3: [], r1: [], r0: [] }; /* копим и шлём ОДНИМ уведомлением на стадию */
  for (const e of rows) {
    const when = e.time ? ` в ${e.time}` : '';
    /* владелец 27.08: напоминания — пушами из приложения (через notif → alerts моста), не в TG */
    const notify = (stage) => batch[stage].push({ title: e.title, when, date: e.date, who: e.who });
    if (e.date === d3 && !e.r3) { notify('r3'); DB.prepare('UPDATE events SET r3=1 WHERE id=?').run(e.id); }
    else if (e.date === d1 && !e.r1) { notify('r1'); DB.prepare('UPDATE events SET r1=1 WHERE id=?').run(e.id); }
    else if (e.date === today && !e.r0 && hour >= 3) { notify('r0'); DB.prepare('UPDATE events SET r0=1 WHERE id=?').run(e.id); }
  }
  const LABEL = { r3: 'через 3 дня', r1: 'завтра', r0: 'СЕГОДНЯ' };
  for (const [stage, list] of Object.entries(batch)) {
    if (!list.length) continue;
    const head = list.length === 1 ? `📅 ${list[0].title} — ${LABEL[stage]}` : `📅 ${LABEL[stage]}: ${list.length} события`;
    const body = list.map((x) => `• ${x.title}${x.when}${x.who ? ' · ' + x.who : ''}`).join('\n').slice(0, 400);
    DB.prepare('INSERT OR REPLACE INTO notif(id,title,body,at) VALUES(?,?,?,?)')
      .run(`ev-${stage}-${list[0].date}`, head, body, new Date().toISOString());
  }
}

const mode = process.argv[2] || 'digest';
({ digest, urgent: urgentCheck, remind })[mode]()
  .then(() => {
    try { require('../../shared/heartbeat').writeHeartbeat('mail-digest', mode); } catch (_) {}
    process.exit(0);
  })
  .catch((e) => {
    log.error({ err: e.message }, 'mail-digest failed');
    /* лог крона никто не читает (грабля 30-31.08: сутки тишины) → пуш в приложение владельцу */
    try {
      DB.prepare('INSERT OR REPLACE INTO notif(id,title,body,at) VALUES(?,?,?,?)')
        .run('mail-digest-err', '⚠️ Почтовый секретарь споткнулся', String(e.message).slice(0, 140), new Date().toISOString());
    } catch (_) {}
    console.error(e); process.exit(1);
  });
