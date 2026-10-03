'use strict';
/* Автоучёт оплат из банка (владелец 24.09.2026: «агент, который анализирует почту и вносит оплаты автоматом, раз в 10 минут»).
   Читает уведомления CBQ на rekilll@ (включая корзину — владелец убирает их туда), каждое ПРОВЕДЁННОЕ списание
   (Fawran, перевод, SWIFT) вносит разовым расходом во вкладку «Финансы» (мост: finance_add) и шлёт пуш в приложение.
   Дубли исключены по номеру операции банка (таблица bank_tx в data/mail.db).
   Не вносится: зарплаты WPS (уже в постоянных), ежемесячный PRO RCH 1 500 (в постоянных; из первого платежа RCH
   за месяц вычитается, остаток — разовый). Без LLM: письма банка шаблонные.
   node payments.js [--dry] [--days=N]
   24.09: перед списаниями разбираются счета поставщиков из почты (invoices.js); списание, совпавшее со счётом, не вносится. */
const { execFileSync } = require('child_process');
const fs = require('fs');
const Database = require('better-sqlite3');
const gmail = require('./gmail.js').accounts.rekilll;

const DRY = process.argv.includes('--dry');
const DAYS = +((process.argv.find((a) => a.startsWith('--days=')) || '').split('=')[1] || 3);
const USD = 3.64, CR = '207623';
const FIXED = [{ re: /RAPID CLEARING HOUSE/i, monthly: 1500, what: 'PRO RCH (ежемесячно, в постоянных)' }];
const PY = '/home/admin/mcp-servers/jarvis-bridge/.tts-venv/bin/python';

const TEST = process.env.PAY_TEST === '1'; /* проверка: копия базы (PAY_DB), в «Финансы» не пишет */
const DB = new Database(process.env.PAY_DB || __dirname + '/../../data/mail.db');
DB.exec(`CREATE TABLE IF NOT EXISTS bank_tx (ref TEXT PRIMARY KEY, date TEXT, benef TEXT, amount REAL, cref TEXT, action TEXT, booked REAL, at TEXT);
  CREATE TABLE IF NOT EXISTS notif (id TEXT PRIMARY KEY, title TEXT, body TEXT, at TEXT);`);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const z = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (h) => String(h).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const KEYS = 'Transaction Type|Transaction Reference|Company Name|Alias Name|Debit Account Number|Debit Currency|Beneficiary Name|Beneficiary Bank|Beneficiary Alias Name|Transfer Amount\\(in QAR\\)|Value Date|Customer Reference|Purpose of Remittance|Status';
const field = (t, k) => { const m = new RegExp('(?:' + k + ')\\s*:\\s*(.*?)\\s*(?=(?:' + KEYS + ')\\s*:|Should you|$)').exec(t); return m ? m[1].replace(/^#/, '').trim() : ''; };
const iso = (dmy) => { const m = /(\d{1,2})[/-](\w{2,3}|\d{1,2})[/-](\d{4})/.exec(dmy || ''); if (!m) return null; const mon = isNaN(+m[2]) ? 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(m[2].slice(0, 3)) / 3 + 1 : +m[2]; return `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`; };
const num = (s) => +String(s || '').replace(/,/g, '') || 0;

/* письмо банка → операция {ref, type, date, benef, amount(QAR), cref} или null */
async function parse(id) {
  const m = await gmail.get(id, 12000); const t = strip(m.body), subj = m.subject;
  if (/Wage Protection|Bulk-WPS/i.test(subj)) return { ref: (/SIF_\d+_CBQ_\d+_\d+/.exec(subj) || /CIB - (\w+)/.exec(subj) || [])[0] || 'wps-' + id, type: 'WPS', skip: 'зарплаты WPS — в постоянных' };
  if (/Transaction Details/.test(t) && field(t, 'Status') === 'Processed' && field(t, 'Transfer Amount\\(in QAR\\)')) {
    return { ref: field(t, 'Transaction Reference'), type: field(t, 'Transaction Type'), date: iso(field(t, 'Value Date')), benef: field(t, 'Beneficiary Name'), amount: num(field(t, 'Transfer Amount\\(in QAR\\)')), cref: field(t, 'Customer Reference') };
  }
  if (/FUNDS TRANSFER CONFIRMATION/i.test(subj)) { /* SWIFT: подробности только в PDF под паролем = CR */
    const f = (m.files || []).map((x) => x.filename || x).find((x) => /\.pdf$/i.test(x)); if (!f) return null;
    const buf = await gmail.attachment(id, f); const tmp = '/tmp/claude-1000/swift-' + process.pid + '.pdf'; fs.writeFileSync(tmp, buf);
    const txt = execFileSync(PY, ['-c', 'import sys\nfrom pypdf import PdfReader\nr=PdfReader(sys.argv[1])\nif r.is_encrypted: r.decrypt(sys.argv[2])\nprint(" ".join((p.extract_text() or "") for p in r.pages))', tmp, CR], { timeout: 60000 }).toString().replace(/\s+/g, ' ');
    fs.unlinkSync(tmp);
    const cur = /amount of (\w{3}) ([\d,]+\.\d\d)/.exec(txt) || [];
    const amt = num(cur[2]) * (cur[1] === 'USD' ? USD : 1);
    return { ref: (/reference number (\w+)/.exec(txt) || /REF:\s*(\w+)/.exec(subj) || [])[1], type: 'SWIFT ' + (cur[1] || ''), date: iso((/Value Date (\d{1,2}-\w{3}-\d{4})/.exec(txt) || [])[1]), benef: ((/Receiver Name (.+?) Receiver Account/.exec(txt) || [])[1] || '').trim(), amount: Math.round(amt), cref: ((/Purpose (.+?) Processing Date/.exec(txt) || [])[1] || '').trim(), orig: cur[1] ? cur[1] + ' ' + cur[2] : '' };
  }
  return null;
}

/* сколько вносить: WPS — нет; RCH — первый платёж месяца минус ежемесячный PRO */
function decide(tx) {
  if (tx.skip) return { action: 'skip', booked: 0, why: tx.skip };
  const fx = FIXED.find((f) => f.re.test(tx.benef));
  if (fx) {
    const ym = (tx.date || '').slice(0, 7);
    const had = DB.prepare("SELECT 1 FROM bank_tx WHERE benef = ? AND substr(date,1,7) = ? AND action LIKE 'fixed%'").get(tx.benef, ym);
    if (!had) { const rest = Math.round((tx.amount - fx.monthly) * 100) / 100; return rest > 0 ? { action: 'fixed+oneoff', booked: rest, why: fx.what + ' вычтен' } : { action: 'fixed', booked: 0, why: fx.what }; }
  }
  return { action: 'oneoff', booked: tx.amount };
}

(async () => {
  const INV = require('./invoices.js'); /* 24.09: сначала счета из почты — чтобы их оплата из банка не внеслась второй раз */
  try { await INV.run({ dry: DRY, test: TEST }); } catch (e) { log('invoices', e.message); }
  const ids = await gmail.list(`in:anywhere newer_than:${DAYS}d from:cbq.com.qa ("Transaction Details" OR "FUNDS TRANSFER CONFIRMATION" OR "Wage Protection")`, 100);
  let added = 0, seen = 0;
  for (const id of ids.reverse()) { /* по времени: правило «первый платёж RCH за месяц» */
    await z(250); /* минутная квота Gmail API */
    let tx; try { tx = await parse(id); } catch (e) { log('parse fail', id, e.message); continue; }
    if (!tx || !tx.ref) continue;
    if (DB.prepare('SELECT 1 FROM bank_tx WHERE ref = ?').get(tx.ref)) { seen++; continue; }
    let d = decide(tx);
    if (!tx.skip && !DRY) { const inv = INV.matchPayment(tx); if (inv) d = { action: 'paid-invoice', booked: 0, why: 'оплата счёта ' + inv.supplier + ' ' + inv.no + ' (уже внесён по счёту)' }; }
    log(DRY ? '[dry]' : '', tx.ref, tx.type, tx.date, tx.benef, tx.amount, tx.cref, '→', d.action, d.booked, d.why || '');
    if (DRY) continue;
    if (d.booked > 0) {
      const refund = /refund|возврат/i.test(tx.cref || '');
      const name = (refund ? 'Возврат клиенту ' : '') + tx.benef + (tx.cref && !refund ? ` (${tx.cref})` : '') + ' · auto';
      const note = `авто из банка: ${tx.type} ${tx.ref}${tx.orig ? ', ' + tx.orig + ' × ' + USD : ''}${d.why ? '; ' + d.why : ''}`;
      const r = TEST ? (log('[test] finance_add', name, d.booked, tx.date), { ok: true }) : JSON.parse(await require('/home/admin/mcp-servers/jarvis-schedule/bridge.js').call('finance_add', { kind: 'oneoff', name, amount: d.booked, date: tx.date, note }));
      if (!r.ok) { log('finance_add fail', tx.ref, JSON.stringify(r)); continue; } /* не помечаем — повторим через 10 минут */
      DB.prepare('INSERT OR REPLACE INTO notif(id,title,body,at) VALUES(?,?,?,?)').run('pay-' + tx.ref, '💳 Оплата внесена в Финансы', `${tx.benef}: ${d.booked.toLocaleString('ru-RU')} QAR (${tx.date})${tx.cref ? ' · ' + tx.cref : ''}`, new Date().toISOString());
      added++;
    }
    DB.prepare('INSERT OR REPLACE INTO bank_tx(ref,date,benef,amount,cref,action,booked,at) VALUES(?,?,?,?,?,?,?,?)').run(tx.ref, tx.date || null, tx.benef || null, tx.amount || 0, tx.cref || null, d.action, d.booked, new Date().toISOString());
  }
  log('готово: писем', ids.length, 'уже учтено', seen, 'внесено', added);
  process.exit(0);
})().catch((e) => { log('ERR', e.message); process.exit(1); });
