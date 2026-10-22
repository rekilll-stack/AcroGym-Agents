#!/usr/bin/env node
'use strict';
/* 13.10 владелец: «счётчик в боте, который показывает прогресс в реальном времени».
   Одно сообщение в боте владельца, которое правится каждую минуту (крон) по живой статистике rclone (rc 127.0.0.1:5572 core/stats).
   --start (зовёт mirror-yadisk.sh до rclone): база = что уже лежит на Google, объём Яндекса, новое сообщение (закреплено).
   без флагов (крон каждую минуту): копирование идёт — обновить сообщение; не идёт — молчать.
   --final --rc=N (в конце mirror-yadisk.sh): итог в том же сообщении. --dry — только печать. */
const { execFileSync } = require('child_process');
const fs = require('fs');
process.chdir('/home/admin/acrogym');
require('dotenv').config({ path: '.env' });
const tg = require('../shared/telegram');

const RCLONE = '/home/admin/bin/rclone', DST = 'gdrive:YandexDisk-backup', STATE = 'data/mirror-live.json', RC = 'http://127.0.0.1:5572';
const A = process.argv.slice(2), has = (f) => A.includes(f), dry = has('--dry');
const json = (args) => JSON.parse(execFileSync(RCLONE, args, { encoding: 'utf8', timeout: 15 * 60e3 }));
const gb = (b) => (b / 1e9).toFixed(1).replace('.', ',');
const n = (x) => String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const dur = (s) => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? h + ' ч ' + m + ' мин' : m + ' мин'; };
const hhmm = () => new Date().toLocaleTimeString('ru-RU', { timeZone: 'Asia/Qatar', hour: '2-digit', minute: '2-digit' });
const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return null; } };
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s));
const plain = { parse_mode: undefined, disable_web_page_preview: true }; /* без разметки: в MarkdownV2 точки и скобки ломали отправку (грабля 13.10) */

function text(st, live, head) {
  const copied = st.base + (live ? live.bytes : 0), pct = Math.min(100, (copied / st.total) * 100), filled = Math.round(pct / 100 * 16);
  const L = [head || '📦 Копия Яндекс.Диска → Google Drive', '▓'.repeat(filled) + '░'.repeat(16 - filled) + ' ' + pct.toFixed(1).replace('.', ',') + ' %',
    'Скопировано ' + gb(copied) + ' ГБ из ' + gb(st.total) + ' ГБ', 'Файлов на Google: ' + n(st.baseCount + (live ? live.transfers : 0)) + (live && live.transfers ? ' (за этот запуск +' + n(live.transfers) + ')' : '')];
  if (live) {
    const el = live.elapsedTime || 0, avg = el > 0 ? live.bytes / el : 0;
    L.push('Скорость сейчас: ' + ((live.speed || 0) / 1e6).toFixed(1).replace('.', ',') + ' МБ/с · идёт ' + dur(el));
    if (avg > 0 && copied < st.total) L.push('Осталось примерно: ' + dur((st.total - copied) / avg) + ' при нынешней скорости');
    if (live.errors) L.push('Яндекс не отдал за этот запуск: ' + n(live.errors) + ' — уйдут в список повреждённых');
  }
  try { const k = fs.readFileSync('data/mirror-skip.txt', 'utf8').split('\n').filter(Boolean).length; if (k) L.push('Повреждённые на Яндексе (не копирую): ' + n(k)); } catch (_) { /* списка ещё нет */ }
  L.push('Обновлено ' + hhmm());
  return L.join('\n');
}
async function stats() { try { const r = await fetch(RC + '/core/stats', { method: 'POST', signal: AbortSignal.timeout(5000) }); return r.ok ? r.json() : null; } catch (_) { return null; } }
async function edit(st, t) {
  if (dry) return console.log(t);
  for (const m of st.msgs || []) await tg.editMessage('owner', m.chat, m.id, t, plain).catch(() => {}); /* «message is not modified» и т.п. — не страшно */
}

(async () => {
  if (has('--start')) {
    const g = json(['size', DST, '--json', '--fast-list']), total = json(['about', 'yadisk:', '--json']).used;
    const st = { base: g.bytes, baseCount: g.count, total, startedAt: Date.now(), msgs: [] }, t = text(st, null, '📦 Копия Яндекс.Диска → Google Drive · запуск');
    if (dry) return console.log(t);
    const sent = await tg.sendToOwner(t, { ...plain, disable_notification: true });
    st.msgs = (sent || []).map((m) => ({ chat: m.chat.id, id: m.message_id }));
    save(st);
    const bot = tg.getOwnerBot ? tg.getOwnerBot() : null;
    if (bot) for (const m of st.msgs) await bot.pinChatMessage(m.chat, m.id, { disable_notification: true }).catch(() => {}); /* закрепить сверху чата */
    return;
  }
  const st = load(); if (!st) return;
  if (has('--final')) {
    const rc = +((A.find((x) => x.startsWith('--rc=')) || '--rc=1').slice(5)), live = (await stats()) || st.last || null;
    const head = rc === 0 ? '✅ Копирование за ночь закончено' : rc === 10 ? '⏸ Остановлено по лимиту 20 ч — продолжу следующей ночью' : '⚠️ Запуск закончился (код ' + rc + ') — продолжу следующей ночью';
    await edit(st, text(st, live, head)); if (!dry) { st.done = true; save(st); } return;
  }
  if (st.done) return;
  const live = await stats(); if (!live) return; /* копирование не идёт */
  st.last = { bytes: live.bytes, transfers: live.transfers, errors: live.errors, elapsedTime: live.elapsedTime, speed: live.speed };
  if (!dry) save(st);
  await edit(st, text(st, live));
})().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
