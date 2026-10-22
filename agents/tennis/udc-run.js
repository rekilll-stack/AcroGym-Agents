#!/usr/bin/env node
/**
 * Бронь корта UDC через API (код владельца, udc-api/udc_booker.py) — крон 0 0 * * 0-4 (TZ сервера = Доха).
 * Правила недели (week.js; даты из очереди want.js — без них) → --execute-scheduled → ссылки на оплату в Джарвис, взятые часы → index.js --add (tennis.json + календарь).
 * Модулем: udc(['--execute-once', дата, '--window', 'evening'], { quiet }) — для want.js.
 */
const fs = require('fs'), { execFileSync } = require('child_process'), W = require('./week');
const ROOT = __dirname + '/../..';
const log = (...a) => console.log(new Date().toISOString(), '[udc-api]', ...a);

const DRY = !!process.env.DRY; /* DRY=1 PY=<файл с JSON-строками> — проверка разбора без брони, пушей и календаря */
function notify(title, body) { /* как в udst.js: таблица notif почтового секретаря → алерты моста → пуш в Джарвис */
  if (!DRY) try {
    const db = new (require('better-sqlite3'))(ROOT + '/data/mail.db');
    db.prepare('INSERT OR REPLACE INTO notif(id,title,body,at) VALUES(?,?,?,?)').run('udcapi-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), title, body, new Date().toISOString());
    db.close();
  } catch (e) { log('notif ERR', e.message); }
  log('PUSH', title, '|', body);
}

/** запустить udc_booker.py с аргументами; вернуть 'booked' | 'none' | 'review'. quiet — не пушить «мест нет» */
async function udc(args, { quiet = false } = {}) {
  const env = { ...process.env, ...Object.fromEntries(fs.readFileSync(ROOT + '/.secrets/udc.env', 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) };
  let out, res = 'none';
  if (DRY) out = fs.readFileSync(process.env.PY, 'utf8'); else try { out = execFileSync('python3', ['udc_booker.py', ...args, '--username', 'kirill'], { cwd: __dirname + '/udc-api', env, encoding: 'utf8', timeout: 6 * 60e3 }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  log(out.trim());
  for (const line of out.split('\n')) {
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    if (r.outcome === 'excluded_friday_saturday') continue;
    const b = r.bookings || [], pay = (r.payments || []).filter((p) => p.url);
    if (/^(reserved|confirmed)_/.test(r.outcome) && b.length) {
      res = 'booked';
      const from = b.map((x) => x.time.slice(0, 5)).sort()[0], to = b.map((x) => x.time.slice(6)).sort().pop();
      notify(`🎾 UDC: корт взят · ${r.date} ${from}–${to}`, `${b[0].court} · ${r.total_QAR ?? '?'} QAR` +
        (pay.length ? ' · оплати: ' + pay.map((p) => `${p.amount_QAR} QAR ${p.url}`).join(' · ') + (pay[0].deadline ? ` · до ${pay[0].deadline}` : '') : ''));
      /* 18.10: неоплаченная бронь UDC держится 5 минут — ссылку сразу в Telegram (пуш Джарвиса приходит до 15 мин); в календарь — только после оплаты (ежечасный --sync-confirmed) */
      if (pay.length && !DRY) try { await require('../../shared/telegram.js').sendToOwner(`🎾 UDC ${r.date} ${from}–${to} · ${b[0].court}\nОплатить за 5 минут, иначе бронь снимется:\n` + pay.map((p) => `${p.amount_QAR} QAR: ${p.url}`).join('\n'), { parse_mode: undefined }); } catch (e) { log('telegram ERR', e.message); }
      if (!/^confirmed_/.test(r.outcome)) continue;
      if (!DRY) try { log(execFileSync('node', [__dirname + '/index.js', '--add', JSON.stringify({ date: r.date, from, to, court: /^Giardino/.test(b[0].court) ? 'Giardino' : 'Family Park', src: 'udc-api' })], { cwd: ROOT, encoding: 'utf8' }).trim()); }
      catch (e) { log('add ERR', e.message); }
    } else if (r.outcome === 'no_reservation') { if (!quiet) notify(`🎾 UDC: мест нет · ${r.date}`, `${r.window || ''}${r.reason ? ' · ' + r.reason : ''}`); }
    else { if (res !== 'booked') res = 'review'; notify(`🎾 UDC: проверь бронь · ${r.date || args[1] || ''}`, `${r.outcome}${r.reason ? ' · ' + r.reason : ''}${r.message ? ' · ' + r.message : ''}`); }
  }
  return res;
}
module.exports = { udc, notify };

if (require.main === module && process.argv[2] === '--once') { /* разовая бронь (MCP udc / по просьбе владельца): --once ГГГГ-ММ-ДД evening|morning */
  udc(['--execute-once', process.argv[3], '--window', process.argv[4]]).then((result) => console.log(JSON.stringify({ result })));
} else if (require.main === module) {
  const t = new Date(Date.now() + 7 * 864e5), day = t.toLocaleDateString('sv-SE');
  const queued = (W.load('tennis-want.json', []) || []).some((x) => x.date === day && x.status === 'queued'); /* заказ из Джарвиса важнее правил недели */
  // ponytail: правило «2 вечера в неделю» отсекает весь запуск; в понедельник запускаем всегда ради утра 7–9 (вечер тогда может оказаться лишним — редкий случай)
  if (!queued && !W.want(day) && t.getDay() !== 1) log(day, 'правила недели: не беру');
  else udc(['--execute-scheduled']).catch((e) => log('FATAL', e.message));
}
