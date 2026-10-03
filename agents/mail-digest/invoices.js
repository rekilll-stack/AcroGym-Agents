'use strict';
/* Автоучёт СЧЕТОВ поставщиков (владелец 24.09.2026: «инвойсы ловились, и ты вносил их как минус — вот что мы оплачиваем;
   все инвойсы приходят на рабочую и на rekilll; агент ловит и автоматом добавляет»).
   Раз в 10 минут (из payments.js, ДО банковских списаний): письма обоих ящиков со словами «invoice/bill/счёт…» →
   текст письма + PDF (скан без текста — первая страница картинкой) → нейросеть по ПОДПИСКЕ решает, счёт ли это НАМ к оплате,
   и достаёт поставщика, номер, сумму → разовый расход во вкладке «Финансы» (finance_add) + пуш.
   Двойного счёта нет: (1) счёт вносится один раз по «поставщик|номер»; (2) списание в банке с этим номером в назначении
   payments.js считает оплатой счёта и не вносит; (3) поставщики из постоянных расходов (аренда, PRO RCH, Kahramaa…) —
   вносится только превышение над месячной суммой.
   node invoices.js [--dry] [--days=N]   (PAY_TEST=1 PAY_DB=<копия> — проверка без записи в «Финансы») */
const fs = require('fs');
const Database = require('better-sqlite3');
const G = require('./gmail.js');
const { pdfText, pdfImages } = require('./attach.js');

const USD = 3.64;
/* поставщики из постоянных расходов вкладки «Финансы»: all — счёт целиком уже в постоянных; monthly — вычесть из первого счёта месяца */
const FIXED = [
  { re: /rapid clearing|\brch\b|rch\.qa/i, monthly: 1500, what: 'PRO RCH' },
  { re: /lagoona|darwish|mirqab/i, monthly: 27250, what: 'аренда Lagoona' },
  { re: /assiyana|gulf serv/i, monthly: 1800, what: 'уборка Assiyana' },
  { re: /kahramaa|km\.qa/i, all: true, what: 'электричество Kahramaa' },
  { re: /google/i, all: true, what: 'Google Workspace' },
  { re: /ooredoo/i, all: true, what: 'интернет Ooredoo' },
  { re: /joinin2|\bin2\b/i, all: true, what: 'CRM in2' },
  { re: /\bgig\b|gulf insurance/i, all: true, what: 'страховка GIG' },
];
const DB = new Database(process.env.PAY_DB || __dirname + '/../../data/mail.db');
DB.exec(`CREATE TABLE IF NOT EXISTS inv_seen (msg TEXT PRIMARY KEY, at TEXT);
  CREATE TABLE IF NOT EXISTS invoices (key TEXT PRIMARY KEY, supplier TEXT, no TEXT, amount REAL, cur TEXT, qar REAL, date TEXT, booked REAL, acc TEXT, msg TEXT, status TEXT, at TEXT);
  CREATE TABLE IF NOT EXISTS notif (id TEXT PRIMARY KEY, title TEXT, body TEXT, at TEXT);`);
const log = (...a) => console.log(new Date().toISOString(), '[inv]', ...a);
const z = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (s) => String(s || '').replace(/\D/g, '');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-zа-я0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim();

const PROMPT = `You read one email received by AcroGym Sport Center (a kids gymnastics club in Doha, Qatar; CR 207623; mailboxes info@acrogym.org and rekilll@gmail.com of the owner Kirill).
Decide if it is an INVOICE / BILL that AcroGym must PAY (or has to pay) to a supplier. NOT an invoice to pay: invoices AcroGym issues to its own clients or partners, revenue-share reports where the partner pays AcroGym, payment receipts / "thank you for settlement", quotations / proposals, bank statements, marketing, newsletters, school fee invoices of the owner's children (Queens school) — personal, not the club.
Return JSON only: {"pay": true|false, "supplier": "company name", "invoice_no": "as printed or empty", "amount": number total due (0 if unknown), "currency": "QAR|USD|…", "date": "YYYY-MM-DD invoice date", "what": "short description in Russian", "confidence": 0..1}`;

async function ask(llm, user, images) { const raw = await llm({ system: 'You extract invoice data precisely. JSON only.', user, images, model: 'claude-haiku-4-5-20251001', maxTokens: 600 }); const j = /\{[\s\S]*\}/.exec(raw); return j ? JSON.parse(j[0]) : null; }
async function classify(llm, m, acc, gm) {
  const pdfs = (m.files || []).map((f) => f.filename || f).filter((f) => /\.pdf$/i.test(f)).slice(0, 2);
  let att = ''; for (const f of pdfs) { const t = await pdfText(m.id, f, gm, 2500); att += `\n[PDF ${f}]\n` + (t || '(скан без текста)'); }
  const user = `${PROMPT}\n\nMailbox: ${acc}\nFrom: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}\nAttachments: ${(m.files || []).map((f) => f.filename || f).join(', ') || 'none'}\n\nBody:\n${m.body.slice(0, 3000)}${att}`;
  let r = await ask(llm, user, null);
  /* похоже на счёт, но суммы нет, а PDF — скан: смотрим первую страницу глазами */
  if (r && r.pay && !(+r.amount > 0) && pdfs.length) { const img = await pdfImages(m.id, pdfs[0], gm, 1).catch(() => []); if (img.length) r = await ask(llm, user, img) || r; }
  return r;
}

/* ключ счёта: поставщик из постоянных — по его ярлыку (RCH/Rapid Clearing — одно), иначе первые два слова; + цифры номера */
const keyOf = (inv, id) => { const fx = FIXED.find((f) => f.re.test(inv.supplier) || f.re.test(inv.from || '')); return (fx ? fx.what : norm(inv.supplier).split(' ').slice(0, 2).join(' ')) + '|' + (digits(inv.no) || 'msg' + id); };
/* разобранный счёт → запись в «Финансы» (одна на поставщик|номер) + пуш. src: {acc, id, from, ts, subject} */
async function book(r, src, { dry = false, test = false } = {}) {
  const cur = String(r.currency || 'QAR').toUpperCase(), amt = +r.amount || 0;
  const inv = { supplier: String(r.supplier || String(src.from || '').replace(/<.*>/, '')).trim(), no: String(r.invoice_no || '').trim(), amount: amt, cur, qar: Math.round(amt * (cur === 'USD' ? USD : 1) * 100) / 100, date: /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : new Date((src.ts || Date.now()) + 3 * 3600e3).toISOString().slice(0, 10), what: r.what || '', from: src.from || '' };
  const key = keyOf(inv, src.id);
  if (DB.prepare('SELECT 1 FROM invoices WHERE key = ?').get(key)) return { dup: true, inv, key };
  if (!(amt > 0) || (+r.confidence || 0) < 0.6) { /* сомнительно — не вносим, просим глянуть */
    log('проверь вручную:', src.acc, inv.supplier, inv.no, amt, r.confidence);
    if (!dry && !test) DB.prepare('INSERT OR REPLACE INTO notif(id,title,body,at) VALUES(?,?,?,?)').run('inv-chk-' + src.id, '🧾 Счёт: проверь сумму', `${inv.supplier} ${inv.no}: ${String(src.subject || '').slice(0, 80)}`, new Date().toISOString());
    return { check: true, inv, key };
  }
  const d = decide(inv);
  log(dry ? '[dry]' : '', src.acc, inv.supplier, inv.no, inv.amount, cur, inv.date, '→ внести', d.booked, d.why);
  if (dry) return { dry: true, inv, key, booked: d.booked, why: d.why };
  if (d.booked > 0) {
    const name = `Счёт ${inv.supplier}${inv.no ? ' ' + inv.no : ''} · auto`;
    const note = `авто (${src.acc === 'upload' ? 'загружен из приложения' : 'из почты ' + src.acc}): ${inv.what}${cur !== 'QAR' ? `; ${amt} ${cur} × ${USD}` : ''}${d.why ? '; ' + d.why : ''}; оплата этого счёта из банка повторно не вносится`;
    const res = test ? (log('[test] finance_add', name, d.booked, inv.date), { ok: true }) : JSON.parse(await require('/home/admin/mcp-servers/jarvis-schedule/bridge.js').call('finance_add', { kind: 'oneoff', name, amount: d.booked, date: inv.date, note }));
    if (!res.ok) { log('finance_add fail', key, JSON.stringify(res)); return { retry: true }; }
    if (!test) DB.prepare('INSERT OR REPLACE INTO notif(id,title,body,at) VALUES(?,?,?,?)').run('inv-' + key, '🧾 Счёт внесён в Финансы', `${inv.supplier}${inv.no ? ' ' + inv.no : ''}: ${d.booked.toLocaleString('ru-RU')} QAR · ${inv.what}`, new Date().toISOString());
  }
  DB.prepare('INSERT OR REPLACE INTO invoices VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(key, inv.supplier, inv.no, amt, cur, inv.qar, inv.date, d.booked, src.acc, src.id, d.fixed ? 'booked,fixed' : d.booked > 0 ? 'booked' : 'fixed-all', new Date().toISOString());
  return { added: d.booked > 0, inv, key, booked: d.booked, why: d.why };
}

/* счёт, загруженный из приложения (фото/PDF): тот же разбор и запись, результат — пушем. buf — файл, name — имя */
async function processUpload(buf, name, { test = process.env.PAY_TEST === '1' } = {}) {
  const { generateText } = require('../content-bot/llm.js');
  const { execFileSync } = require('child_process');
  const id = 'up' + Date.now(), ext = (String(name).match(/\.(\w+)$/) || [, 'bin'])[1].toLowerCase(), tmp = '/tmp/claude-1000/' + id + '.' + ext;
  fs.writeFileSync(tmp, buf);
  let text = '', images = [];
  try {
    if (ext === 'pdf') {
      text = execFileSync('/home/admin/mcp-servers/jarvis-bridge/.tts-venv/bin/python', ['-c', 'import sys\nfrom pypdf import PdfReader\nr=PdfReader(sys.argv[1])\nif r.is_encrypted: r.decrypt("207623")\nprint(" ".join((p.extract_text() or "") for p in r.pages[:4])[:3000])', tmp], { timeout: 60000 }).toString().trim();
      if (text.length < 40) { const png = tmp + '.png'; execFileSync('node', [__dirname + '/pdfshot.js', tmp, '1', png], { timeout: 90000, stdio: 'pipe' }); images = [{ data: fs.readFileSync(png).toString('base64'), media_type: 'image/png' }]; fs.unlinkSync(png); }
    } else if (/^(jpe?g|png|webp|heic)$/.test(ext)) images = [{ data: buf.toString('base64'), media_type: ext === 'png' ? 'image/png' : 'image/jpeg' }];
    else text = buf.toString('utf8').slice(0, 3000);
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  const user = `${PROMPT}\n\nThe OWNER uploaded this document himself as an invoice/bill AcroGym has to pay (so "pay" is very likely true unless it is clearly not a bill).\nFile: ${name}\n${text ? 'Text:\n' + text : 'The document is attached as an image.'}`;
  const r = await ask(generateText, user, images.length ? images : null);
  const out = r && r.pay ? await book(r, { acc: 'upload', id, from: 'upload', ts: Date.now(), subject: name }, { test }) : { notInvoice: true };
  const msg = out.added ? `✅ ${out.inv.supplier}${out.inv.no ? ' ' + out.inv.no : ''}: ${out.booked.toLocaleString('ru-RU')} QAR внесено в Финансы` : out.dup ? `ℹ️ Этот счёт уже внесён (${out.inv.supplier} ${out.inv.no})` : out.check ? `⚠️ Не разобрал сумму — проверь: ${name}` : out.inv && !out.booked ? `ℹ️ ${out.inv.supplier}: уже в постоянных расходах (${out.why || ''})` : `⚠️ Это не похоже на счёт к оплате: ${name}`;
  if (!test) DB.prepare('INSERT OR REPLACE INTO notif(id,title,body,at) VALUES(?,?,?,?)').run('inv-up-' + id, '🧾 Загруженный счёт', msg, new Date().toISOString());
  log('upload', name, msg);
  return { ...out, msg };
}

function decide(inv) {
  const fx = FIXED.find((f) => f.re.test(inv.supplier) || f.re.test(inv.from || ''));
  if (!fx) return { booked: inv.qar, why: '' };
  if (fx.all) return { booked: 0, why: fx.what + ' — уже в постоянных' };
  const ym = String(inv.date || '').slice(0, 7);
  const had = DB.prepare("SELECT 1 FROM invoices WHERE key LIKE ? AND substr(date,1,7) = ? AND status LIKE '%fixed%'").get(fx.what + '|%', ym); /* по ярлыку поставщика: «RCH» и «Rapid Clearing House W.L.L.» — одно */
  if (had) return { booked: inv.qar, why: '' };
  return { booked: Math.max(0, Math.round((inv.qar - fx.monthly) * 100) / 100), why: fx.what + ' ' + fx.monthly + ' в постоянных — вычтено', fixed: true };
}

async function run({ dry = false, days = 3, test = process.env.PAY_TEST === '1' } = {}) {
  const { generateText } = require('../content-bot/llm.js'); /* подписочный шим, не платный API */
  let added = 0;
  for (const acc of ['info', 'rekilll']) {
    const gm = G.accounts[acc]; if (acc === 'info' && !G.hasInfo()) continue;
    const ids = await gm.list(`in:anywhere newer_than:${days}d -from:cbq.com.qa -from:acrogym.org (invoice OR inv OR "e-bill" OR bill OR "tax invoice" OR "amount due" OR "payment due" OR счёт OR счет OR فاتورة)`, 60);
    for (const id of ids.reverse()) {
      if (DB.prepare('SELECT 1 FROM inv_seen WHERE msg = ?').get(id)) continue;
      await z(300); /* минутная квота Gmail API */
      let m; try { m = await gm.get(id, 4000); } catch (e) { log('get fail', id, e.message); continue; }
      if (/receipt|квитанц/i.test(m.subject) || /thank you for the settlement|corresponding receipt for your reference|payment (has been )?received|thank you for (your )?payment/i.test(m.body.slice(0, 400))) /* 24.09: письмо-счёт RCH само содержит «…share the corresponding receipt» — по одному слову receipt в теле его отсеивало */ { if (!dry) DB.prepare('INSERT OR IGNORE INTO inv_seen VALUES (?,?)').run(id, new Date().toISOString()); continue; }
      let r; try { r = await classify(generateText, m, acc, gm); } catch (e) { log('llm fail', id, e.message); continue; } /* не помечаем — повторим */
      const mark = () => { if (!dry) DB.prepare('INSERT OR IGNORE INTO inv_seen VALUES (?,?)').run(id, new Date().toISOString()); };
      if (!r || !r.pay) { log('не счёт к оплате:', acc, m.subject.slice(0, 70)); mark(); continue; }
      const b = await book(r, { acc, id, from: m.from, ts: m.ts, subject: m.subject }, { dry, test });
      if (b.retry) continue; /* finance_add не прошёл — повторим через 10 минут */
      if (b.added) added++;
      mark();
    }
  }
  log('счета: внесено', added);
  return added;
}

/* для payments.js: это списание в банке — оплата уже внесённого счёта? (номер счёта в назначении платежа, иначе поставщик+сумма ±45 дней) */
function matchPayment(tx) {
  const cd = digits(tx.cref);
  for (const r of DB.prepare("SELECT * FROM invoices WHERE status NOT LIKE '%paid%'").all()) {
    const nd = digits(r.no);
    const byNo = nd.length >= 3 && cd.includes(nd);
    const byName = norm(tx.benef).split(' ')[0] && norm(r.supplier).includes(norm(tx.benef).split(' ')[0]) && Math.abs((+r.qar || 0) - (+tx.amount || 0)) < 1 && Math.abs(Date.parse(tx.date) - Date.parse(r.date)) < 45 * 864e5;
    if (byNo || byName) { DB.prepare("UPDATE invoices SET status = status || ',paid' WHERE key = ?").run(r.key); return r; }
  }
  return null;
}

module.exports = { run, matchPayment, processUpload, book };
if (require.main === module) {
  run({ dry: process.argv.includes('--dry'), days: +((process.argv.find((a) => a.startsWith('--days=')) || '').split('=')[1] || 3) })
    .then(() => process.exit(0)).catch((e) => { log('ERR', e.message); process.exit(1); });
}
