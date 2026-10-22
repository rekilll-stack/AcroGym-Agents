#!/usr/bin/env node
/* Разовая задача (владелец 28.08): после сброса квоты Make вернуть поллинг лидов с 3 часов на 60 минут.
   Ставится в крон на 29.08 16:00 UTC (19:00 Дохи, сброс квоты в 15:29 UTC). После успеха снимает себя из крона. */
require('dotenv').config({ path: __dirname + '/../.env' });
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const TOKEN = process.env.MAKE_API_TOKEN;
const API = 'https://eu1.make.com/api/v2';
const H = { Authorization: 'Token ' + TOKEN, 'User-Agent': 'acrogym-ops/1.0', 'Content-Type': 'application/json' };
const SCENARIO = 6376743, ORG = 8213226;

const push = (title, body) => {
  try {
    const db = new Database('/home/admin/acrogym/data/mail.db');
    db.prepare('INSERT OR REPLACE INTO notif(id,title,body,at) VALUES(?,?,?,?)')
      .run('make-interval-' + new Date().toISOString().slice(0, 10), title, body, new Date().toISOString());
    db.close();
  } catch (e) { console.error('пуш не записан:', e.message); }
};

(async () => {
  const org = (await (await fetch(`${API}/organizations/${ORG}`, { headers: H })).json()).organization;
  const left = (+org.license.operations || 1000) - +org.operations;
  console.log(new Date().toISOString(), 'операций осталось:', left);
  if (left < 300) { /* сброс ещё не прошёл — не трогаем, попробуем в следующий раз */
    console.log('квота ещё не сброшена, интервал не меняю');
    push('⏳ Make: квота ещё не сброшена', `осталось ${left} операций, интервал оставил 3 часа`);
    process.exit(0);
  }
  const r = await fetch(`${API}/scenarios/${SCENARIO}`, { method: 'PATCH', headers: H,
    /* ГРАБЛЯ 29.08: Make принимает scheduling ТОЛЬКО строкой с JSON внутри; объектом → 400 */
    body: JSON.stringify({ scheduling: JSON.stringify({ type: 'indefinitely', interval: 3600 }) }) });
  const j = await r.json();
  const sch = j.scenario && j.scenario.scheduling;
  const now = typeof sch === 'string' ? (JSON.parse(sch).interval || null) : (sch && sch.interval) || null;
  console.log('ответ Make:', r.status, 'интервал теперь:', now);
  if (r.ok && now === 3600) {
    push('✅ Make: лиды снова раз в час', `квота сброшена (${left} операций), интервал 3 ч → 60 мин`);
    /* снимаем себя из крона — задача разовая */
    const cur = execSync('crontab -l', { encoding: 'utf8' });
    execSync('crontab -', { input: cur.split('\n').filter((l) => !/make-interval-60/.test(l)).join('\n') });
    console.log('строка крона удалена — задача разовая');
  } else {
    push('⚠️ Make: не удалось вернуть 60 мин', `HTTP ${r.status} — интервал остался ${now || '?'}`);
    process.exit(1);
  }
})().catch((e) => { console.error('ошибка:', e.message); process.exit(1); });
