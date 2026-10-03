'use strict';
/* Ответчик: готовит черновик (draft) и отправляет ТОЛЬКО после подтверждения владельца (send). */
require('dotenv').config({ path: __dirname + '/../../.env' });
const fs = require('fs');
const Database = require('better-sqlite3');
const gmail = require('./gmail.js');
const { generateText } = require('../content-bot/llm.js') /* подписочный шим: разбор почты не должен жечь платный API (правило владельца) */;
const DB = new Database(__dirname + '/../../data/mail.db');
DB.exec("CREATE TABLE IF NOT EXISTS drafts (msg_id TEXT PRIMARY KEY, to_addr TEXT, subject TEXT, body TEXT, attach TEXT, created_at TEXT, sent_at TEXT)");
try { DB.exec('ALTER TABLE drafts ADD COLUMN note TEXT'); } catch (_) {} /* последнее замечание владельца — видно в приложении */
try { DB.exec('ALTER TABLE drafts ADD COLUMN warn TEXT'); } catch (_) {}
try { DB.exec('ALTER TABLE drafts ADD COLUMN from_acc TEXT'); } catch (_) {} /* с какого ящика отправлять */ /* «просил файл, которого нет» — видно в приложении */

/* Белый список файлов, которые агент может приложить (бренд-ассеты) */
const ASSETS = {
  'logo.svg': '/home/admin/acrogym/config/brand/logo.svg',
  'logo.png': '/home/admin/acrogym/config/brand/logo.png',
  'logo-white.png': '/home/admin/acrogym/config/brand/logo-white.png',
  'AcroGym-Prices-2026-27.pdf': '/home/admin/acrogym/docs/AcroGym-Price-List.pdf', /* 06.09: файл переименован 01.09 — вложение прайса в почте было битым */
  'AcroGym-Brand-Kit.zip': '/home/admin/acrogym/config/brand/AcroGym-Brand-Kit.zip',
  'AcroGym-Brand-Official.zip': '/home/admin/acrogym/config/brand/AcroGym-Brand-Official.zip',
};

/** Модель иногда кладёт в JSON сырые переносы строк внутри значений — обычный JSON.parse на этом падает
    («Bad control character», поймано живьём 28.08). Экранируем управляющие символы внутри строк и парсим. */
function parseDraftJson(raw) {
  const m = String(raw).replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('модель вернула не JSON: ' + String(raw).slice(0, 120));
  const t = m[0];
  try { return JSON.parse(t); } catch (_) {}
  let out = '', inStr = false, esc = false;
  for (const c of t) {
    if (esc) { out += c; esc = false; continue; }
    if (c === '\\') { out += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (inStr && (c === '\n' || c === '\r' || c === '\t')) { out += c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\t'; continue; }
    out += c;
  }
  return JSON.parse(out);
}
async function draft(msgId, note) {
  const row = DB.prepare('SELECT summary, detail, acc FROM mail WHERE id=?').get(msgId) || {};
  const gm = gmail.forAcc(row.acc);
  const m = await gm.get(msgId, 6000);
  /* правка по замечанию владельца: показываем модели прошлый черновик и что переделать */
  const prev = note ? DB.prepare('SELECT subject, body, attach FROM drafts WHERE msg_id=?').get(msgId) : null;
  const curAttach = prev ? (() => { try { return JSON.parse(prev.attach || '[]'); } catch (_) { return []; } })() : [];
  const up = uploads(msgId); /* файлы, которые владелец загрузил с телефона */
  const choices = [...Object.keys(ASSETS), ...up];
  const prompt = `Ты — ассистент Кирилла, владельца AcroGym Sport Center (детская гимнастика, Lagoona Mall, Доха). Подготовь ЧЕРНОВИК ответа на письмо. Кирилл проверит и сам решит, отправлять ли.

ПИСЬМО:
FROM: ${m.from}
SUBJECT: ${m.subject}
TEXT: ${m.body.slice(0, 4000)}

КОНТЕКСТ: ${row.summary || ''} ${row.detail || ''}

ФАКТЫ ДЛЯ ОТВЕТОВ:
- Открытие AcroGym: 1 сентября 2026, Lagoona Mall. Контакт: info@acrogym.org, +974 7085 9382, сайт acrogym.org.
- Логотип: доступны SVG (векторный), PNG (прозрачный), белая версия PNG. Форматов AI/EPS нет — SVG является полноценным вектором и подходит для печати/производства.
- Регистрация клиентов: acrogym.org/register. Прайс-лист PDF есть.
- Кирилл пишет по-английски вежливо, тепло, коротко и по делу; подпись: Kirill, AcroGym Sport Center.

ФАЙЛЫ, которые можно приложить (ТОЛЬКО эти имена, дословно):
${choices.map((c) => '- ' + c + (FILE_NOTE[c] ? ' — ' + FILE_NOTE[c] : ' — файл Кирилла с телефона')).join('\n') || '—'}
Если названо свойство файла («белый логотип», «вектор», «прайс») — выбери РОВНО ОДИН подходящий файл, а не все похожие.
Имена вида «upload:…» — это файлы, которые Кирилл сам загрузил с телефона под это письмо.
${note ? 'РЕЖИМ ПРАВКИ: ты НЕ выбираешь вложения сам. Итоговый attach = «СЕЙЧАС ПРИЛОЖЕНО» плюс/минус ровно то, что сказано в замечании. Ни одного файла сверх этого.' : 'Приложи файлы, только если это уместно по смыслу письма.'}

${prev ? `\nПРОШЛЫЙ ЧЕРНОВИК (его надо ИСПРАВИТЬ, а не писать с нуля):\nSubject: ${prev.subject}\n${prev.body}\nСЕЙЧАС ПРИЛОЖЕНО: ${curAttach.length ? curAttach.join(', ') : '(ничего)'}\n\nЗАМЕЧАНИЕ КИРИЛЛА (выполни его ТОЧНО, остальное сохрани): «${String(note).slice(0, 500)}»\n\nПРО ВЛОЖЕНИЯ — ВАЖНО: поле "attach" в ответе задаёт ИТОГОВЫЙ набор файлов.\n- Если в замечании про вложения ничего нет — верни «СЕЙЧАС ПРИЛОЖЕНО» без изменений.\n- «убери вложения/убери всё» → attach: [].\n- «приложи X / вложи другое» → добавь РОВНО то, что просит Кирилл, и НИЧЕГО СВЕРХУ по своей инициативе (просит прайс — только прайс; просит логотип — только его; файлы с телефона имеют вид upload:…).
- «вложи другое / замени вложение» → старые файлы из attach УБРАТЬ, оставить только новые.\nЕсли замечание на русском — сам ответ всё равно пиши на языке исходного письма.` : ''}

ЕСЛИ Кирилл просит файл, которого НЕТ в списке — не молчи: не выдумывай имя, а честно напиши это в поле "warn" по-русски (например: «архива с фото нет, могу приложить только логотипы»).

Верни ТОЛЬКО JSON: {"subject":"Re: …","body":"<текст письма, обычный текст с абзацами>","attach":["файлы из списка или пусто"],"note_ru":"<одной строкой по-русски: что ты предлагаешь ответить>","warn":"<пусто или что не смог выполнить>"}`;
  const raw = await generateText({
    system: 'You draft plain-text emails. Reply with JSON only. The "body" field must be PLAIN TEXT as it will be sent: no markdown, no **bold**, no #headings, no bullet characters other than "- ". Section labels are written as normal words followed by a colon.',
    user: prompt, maxTokens: 1500, model: 'claude-haiku-4-5-20251001' });
  const j = parseDraftJson(raw);
  if (j.body) j.body = String(j.body).replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s*/gm, '').replace(/^\s*[*•]\s+/gm, '- '); /* письмо простым текстом */
  j.attach = (j.attach || []).filter((a) => resolveAttach(msgId, a)); /* бренд-ассеты И файлы с телефона */
  const to = (m.from.match(/<([^>]+)>/) || [, m.from])[1];
  DB.prepare('INSERT OR REPLACE INTO drafts(msg_id,to_addr,subject,body,attach,created_at,sent_at,note) VALUES(?,?,?,?,?,?,NULL,?)')
    .run(msgId, to, j.subject || ('Re: ' + m.subject), j.body, JSON.stringify(j.attach), new Date().toISOString(), note || null);
  return { to, subject: j.subject || ('Re: ' + m.subject), body: j.body, attach: j.attach, note_ru: j.note_ru || '', warn: j.warn || '' };
}

/** RFC 2047 для темы с кириллицей/эмодзи — иначе Gmail покажет кракозябры. */
const encodeHeader = (v) => (/^[\x20-\x7E]*$/.test(String(v)) ? String(v) : '=?UTF-8?B?' + Buffer.from(String(v), 'utf8').toString('base64') + '?=');
const FROM_NAME = { info: 'AcroGym Sport Center <info@acrogym.org>', rekilll: 'Kirill Bazhanov <rekilll@gmail.com>' };

async function send(msgId) {
  const d = DB.prepare('SELECT * FROM drafts WHERE msg_id=?').get(msgId);
  if (!d) throw new Error('черновика нет — сначала draft');
  if (d.sent_at) throw new Error('уже отправлено ' + d.sent_at);
  /* с какого ящика отправляем: выбор владельца (drafts.from_acc), иначе — ящик, куда письмо пришло */
  const mrow = DB.prepare('SELECT acc, cat FROM mail WHERE id=?').get(msgId) || {};
  const inbox = mrow.acc || 'rekilll';
  /* ПРАВИЛО ВЛАДЕЛЬЦА (28.08): отвечаем ВСЕГДА с того ящика, НА КОТОРЫЙ письмо пришло.
     Моя прежняя «умная» логика (деловое → info@) отправила ответ Charbel не с того адреса — так больше не делать.
     Сменить ящик может только сам владелец кнопкой в приложении (drafts.from_acc). */
  const fromAcc = d.from_acc || inbox;
  const gm = gmail.forAcc(fromAcc);
  const fromHeader = FROM_NAME[fromAcc] || FROM_NAME.rekilll;
  const orig = await gmail.forAcc(inbox).get(msgId, 10); /* тред читаем из ЯЩИКА ПОЛУЧЕНИЯ */
  const boundary = 'b' + Date.now();
  const parts = [];
  parts.push('--' + boundary + '\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + d.body + '\r\n');
  for (const name of JSON.parse(d.attach || '[]')) {
    const p = resolveAttach(msgId, name); if (!p || !fs.existsSync(p)) continue;
    const fname = name.startsWith('upload:') ? name.slice(7) : name;
    const ext = (fname.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    const mime = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', pdf: 'application/pdf',
      doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      heic: 'image/heic', mp4: 'video/mp4', txt: 'text/plain' }[ext] || 'application/octet-stream';
    parts.push('--' + boundary + '\r\nContent-Type: ' + mime + '; name="' + fname + '"\r\nContent-Disposition: attachment; filename="' + fname + '"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + fs.readFileSync(p).toString('base64').replace(/(.{76})/g, '$1\r\n') + '\r\n');
  }
  parts.push('--' + boundary + '--');
  // заголовок треда
  const midHdr = await gmailRaw(msgId, gmail.forAcc(inbox));
  /* ГРАБЛЯ 28.08: .filter(Boolean) вырезал ПУСТУЮ СТРОКУ между заголовками и телом → письмо уходило
     без текста, одним вложением. Пустые заголовки чистим ДО сборки, разделитель добавляем явно. */
  const headers = [
    'From: ' + fromHeader,
    'To: ' + d.to_addr,
    'Subject: ' + encodeHeader(d.subject),
    midHdr ? 'In-Reply-To: ' + midHdr : null,
    midHdr ? 'References: ' + midHdr : null,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
  ].filter(Boolean);
  const raw = headers.join('\r\n') + '\r\n\r\n' + parts.join('');
  const res = await gm.send(Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    fromAcc === inbox ? orig.threadIdRaw : null); /* threadId принадлежит ящику получения — из другого ящика его слать нельзя */
  DB.prepare('UPDATE drafts SET sent_at=? WHERE msg_id=?').run(new Date().toISOString(), msgId);
  return res;
}
/** С какого ящика отправлять этот ответ (владелец переключает в приложении). */
function setFrom(msgId, acc) {
  const a = acc === 'info' ? 'info' : 'rekilll';
  const r = DB.prepare('UPDATE drafts SET from_acc=? WHERE msg_id=? AND sent_at IS NULL').run(a, msgId);
  if (!r.changes) throw new Error('черновика нет или он уже отправлен');
  return a;
}
async function gmailRaw(msgId, gm = gmail) {
  try { const m = await gm.getHeaders(msgId); return m['message-id'] || null; } catch (_) { return null; }
}
/* Файлы, загруженные владельцем с телефона: data/mail-uploads/<msgId>/<имя>. В черновике хранятся
   как 'upload:<имя>' — так они не путаются с бренд-ассетами из белого списка. */
const FILE_NOTE = {
  'logo.svg': 'логотип, вектор (для печати и производства)',
  'logo.png': 'логотип цветной, PNG с прозрачным фоном',
  'logo-white.png': 'логотип БЕЛЫЙ, PNG с прозрачным фоном (для тёмного фона)',
  'AcroGym-Prices-2026-27.pdf': 'прайс-лист на сезон 2026/27, PDF',
  'AcroGym-Brand-Kit.zip': 'ZIP с брендом: логотипы (вектор SVG, цветной PNG, белый PNG, PDF, размеры 240x80 и 150x150), фирменные цвета и шрифт',
  'AcroGym-Brand-Official.zip': 'ОФИЦИАЛЬНЫЙ бренд-архив от Кирилла: logo.svg, logo.png, logo-white.png, аватары, brand.json, README — присылать партнёрам как есть',
};
const UPDIR = '/home/admin/acrogym/data/mail-uploads';
const upPath = (msgId, name) => `${UPDIR}/${String(msgId).replace(/[^a-zA-Z0-9]/g, '')}/${String(name).replace(/[\/\\]/g, '_')}`;
function uploads(msgId) {
  try { return fs.readdirSync(upPath(msgId, '.').replace(/\/\.$/, '')).map((n) => 'upload:' + n); } catch (_) { return []; }
}
function resolveAttach(msgId, name) {
  if (name.startsWith('upload:')) { const p = upPath(msgId, name.slice(7)); return fs.existsSync(p) ? p : null; }
  return ASSETS[name] || null;
}
/** Список файлов, которые агент вправе прикладывать (для UI приложения). */
function assets() { return Object.keys(ASSETS); }
/** Заменить набор вложений в готовом черновике (владелец правит перед отправкой). */
function setAttach(msgId, files) {
  const ok = (files || []).filter((f) => resolveAttach(msgId, f));
  const r = DB.prepare('UPDATE drafts SET attach=? WHERE msg_id=? AND sent_at IS NULL').run(JSON.stringify(ok), msgId);
  if (!r.changes) throw new Error('черновика нет или он уже отправлен');
  return ok;
}
module.exports = { draft, send, assets, setAttach, setFrom, ASSETS, uploads, upPath, resolveAttach, UPDIR };
