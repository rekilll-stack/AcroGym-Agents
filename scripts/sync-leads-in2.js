#!/usr/bin/env node
'use strict';

/**
 * Синхронизация лидов → in2 CRM (запрошено владельцем 22.08.2026).
 * Берёт из data/acrogym.db лиды без in2_lead_id (созданные после старта синка),
 * создаёт их в in2 (POST /leads, статус New) + NOTE с возрастом ребёнка,
 * записывает in2_lead_id обратно. Идемпотентно, безопасно гонять хоть каждую минуту.
 *
 * Запуск: cron каждые 5 минут. Ручной прогон: node scripts/sync-leads-in2.js
 * Dry-run: SYNC_DRY=1 node scripts/sync-leads-in2.js
 */

require('dotenv').config({ path: '/home/admin/acrogym/.env' });
const in2 = require('/home/admin/acrogym/shared/in2');
const Database = require('/home/admin/acrogym/node_modules/better-sqlite3');

const DB = '/home/admin/acrogym/data/acrogym.db';
const SINCE = '2026-08-22'; // историю до запуска синка не заливаем
const DRY = process.env.SYNC_DRY === '1';
const log = (...a) => console.log(new Date().toISOString(), ...a);

const SOURCE_MAP = {
  meta_make: { name: 'Meta Ads (Instagram/Facebook)', how: 'SOCIAL_MEDIA' },
  website_form: { name: 'Website form acrogym.org', how: 'WEBSITE' },
};

(async () => {
  const db = new Database(DB);
  const cols = db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name);
  if (!cols.includes('in2_lead_id')) {
    db.prepare('ALTER TABLE leads ADD COLUMN in2_lead_id INTEGER').run();
    log('добавлена колонка in2_lead_id');
  }
  const rows = db.prepare(
    "SELECT id, parent_name, phone_normalized, email_normalized, source, child_age, lead_uid, created_at FROM leads WHERE in2_lead_id IS NULL AND created_at >= ? AND parent_name != '' ORDER BY created_at",
  ).all(SINCE);
  if (!rows.length) { log('новых лидов нет'); db.close(); return; }
  log(`к заливке: ${rows.length}`);

  let ok = 0;
  for (const r of rows) {
    const src = SOURCE_MAP[r.source] || { name: r.source || 'unknown', how: 'OTHERS' };
    const body = {
      name: r.parent_name,
      leadSource: 'ONLINE',
      idLeadStatus: 1, // New
      leadSourceName: src.name,
      howDidYouHear: src.how,
    };
    if (r.phone_normalized) body.phoneNumber = '+' + String(r.phone_normalized).replace(/^\+/, '');
    if (r.email_normalized) body.email = r.email_normalized;
    if (DRY) { log('[DRY]', r.id, JSON.stringify(body)); continue; }
    try {
      const created = await in2.call('/leads', { method: 'POST', body });
      const in2Id = created && (created.id || (created.data && created.data.id));
      if (!in2Id) throw new Error('нет id в ответе: ' + JSON.stringify(created).slice(0, 200));
      db.prepare('UPDATE leads SET in2_lead_id = ? WHERE id = ?').run(in2Id, r.id);
      if (r.child_age) {
        await in2.call(`/leads/${in2Id}/activities`, { method: 'POST',
          body: { type: 'NOTE', content: `Child age: ${r.child_age}. Imported from ${src.name} (uid ${r.lead_uid || r.id}).` } })
          .catch((e) => log(`лид ${r.id}: NOTE не записалась:`, e.message));
      }
      ok++;
      log(`лид ${r.id} (${r.parent_name}) → in2 #${in2Id}`);
    } catch (e) {
      // не помечаем — следующий прогон попробует снова
      log(`лид ${r.id} ОШИБКА:`, e.message);
    }
  }
  log(`готово: ${ok}/${rows.length}`);
  db.close();
})();
