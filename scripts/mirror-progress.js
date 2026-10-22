#!/usr/bin/env node
'use strict';
/* 13.10 владелец: «хочу видеть процесс копирования из Яндекса в Гугл».
   Крон раз в 3 часа: пока идёт mirror-yadisk.sh — сколько уже на Google из объёма Яндекса, прирост, скорость, примерный срок.
   --final (зовёт mirror-yadisk.sh в конце): итог запуска + сколько файлов Яндекс не отдал. */
const { execFileSync } = require('child_process');
const fs = require('fs');
process.chdir('/home/admin/acrogym');
require('dotenv').config({ path: '.env' });
const { sendToOwner } = require('../shared/notify');

const RCLONE = '/home/admin/bin/rclone', DST = 'gdrive:YandexDisk-backup';
const LOCK = 'data/.mirror-yadisk.lock', STATE = 'data/mirror-progress.json', LOG = 'logs/mirror-yadisk.log';
const final = process.argv.includes('--final');
const running = () => { try { execFileSync('flock', ['-n', LOCK, 'true']); return false; } catch (_) { return true; } };
const json = (args) => JSON.parse(execFileSync(RCLONE, args, { encoding: 'utf8', timeout: 15 * 60e3 }));
const gb = (b) => (b / 1e9).toFixed(1).replace('.', ',');

(async () => {
  if (!final && !running()) return; /* копирование не идёт — молчим */
  const st = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return {}; } })();
  const yaUsed = json(['about', 'yadisk:', '--json']).used;
  const g = json(['size', DST, '--json', '--fast-list']);
  const pct = Math.min(100, Math.floor((g.bytes / yaUsed) * 100));
  let msg = `📦 Копия Яндекс.Диска → Google Drive\nСкопировано ${gb(g.bytes)} ГБ из ${gb(yaUsed)} ГБ (${pct} %), файлов ${g.count}`;
  if (st.at && g.bytes > st.bytes) {
    const h = (Date.now() - st.at) / 3600e3, rate = (g.bytes - st.bytes) / h;
    msg += `\nЗа ${h.toFixed(1).replace('.', ',')} ч +${gb(g.bytes - st.bytes)} ГБ`;
    if (rate > 0 && g.bytes < yaUsed) msg += ` · при таком темпе осталось ~${Math.ceil((yaUsed - g.bytes) / rate / 24)} дн.`;
  } else if (st.at && !final) msg += '\n⚠️ С прошлого отчёта прироста нет — смотрю лог';
  if (final) {
    const run = fs.readFileSync(LOG, 'utf8').split(/\n(?=\d{4}-\d\d-\d\d \d\d:\d\d:\d\d старт)/).pop(); /* лог только последнего запуска */
    const bad = new Set((run.match(/ERROR : ([^:]+): Failed to copy/g) || []).map((s) => s));
    const rc = +(process.argv.find((x) => /^--rc=/.test(x)) || '--rc=1').slice(5);
    const head = rc === 0 ? '✅ Копирование за ночь закончено' : rc === 10 ? '⏸ Копирование остановлено по лимиту 20 ч — продолжу следующей ночью' : `⚠️ Копирование за ночь закончено с ошибками (код ${rc})`;
    msg = head + '\n' + msg.split('\n').slice(1).join('\n');
    if (bad.size) msg += `\nЯндекс не отдал ${bad.size} файл(ов) (сбой их хранилища) — попробую снова следующей ночью`;
  }
  if (process.argv.includes('--dry')) return console.log(msg); /* проверка руками — состояние не трогаем */
  fs.writeFileSync(STATE, JSON.stringify({ at: Date.now(), bytes: g.bytes, count: g.count }));
  await sendToOwner(msg, { parse_mode: undefined }); /* без разметки: MarkdownV2 ронял отправку на точках и скобках (13.10) */
})().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
