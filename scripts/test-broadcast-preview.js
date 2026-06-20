'use strict';

/**
 * B3 — broadcast preview/dry-run formatter test (temp DB only).
 * Self-isolating: seeds its OWN opted-in registrations (NEVER touches prod).
 * Proves rendering, masking (no full number, no last name), empty audience,
 * age children_preview, both languages, and that the formatter is read-only.
 *
 *   rm -f /tmp/b3.db*
 *   sqlite3 data/acrogym.db ".backup '/tmp/b3.db'"   # consistent — captures WAL
 *   ACROGYM_DB_PATH=/tmp/b3.db node scripts/test-broadcast-preview.js
 */

if (!process.env.ACROGYM_DB_PATH || process.env.ACROGYM_DB_PATH.includes('data/acrogym.db')) {
  console.error('REFUSING: set ACROGYM_DB_PATH to a temp copy first.'); process.exit(1);
}
{
  const fs = require('fs');
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(process.env.ACROGYM_DB_PATH + ext)) {
    console.error(`REFUSING: stale ${process.env.ACROGYM_DB_PATH + ext} — delete .db,-wal,-shm together.`); process.exit(1);
  }
}

const { getDb, upsertRegistration } = require('../shared/db');
const { t } = require('../shared/i18n');
const { resolveAudience } = require('../shared/broadcast/resolver');
const { buildPreview, buildDryRun } = require('../agents/owner-bot/builders/broadcast-preview');

const db = getDb();
let pass = 0, fail = 0;
const T = (n, c) => { if (c) { console.log('  ✅ ' + n); pass++; } else { console.log('  ❌ ' + n); fail++; } };

const kids = (arr) => JSON.stringify({ declared_count: arr.length, children: arr, needs_review: false });
const mk = (over) => Object.assign({
  submitted_at: '1/1/2026 10:00:00', parent_first: 'P', parent_last: 'HIDDENLAST', email: 'p@x.com',
  mobile_norm: '97450000001', whatsapp_norm: '97450000001',
  children_json: kids([{ first_name: 'K', last_name: '', dob: '1/1/2019' }]), children_count: 1,
  whatsapp_optin: 1, optin_at: '1/1/2026 10:00:00', optin_version: 'wa_v1',
  photo_consent: 0, tc_accepted: 1, qid: null, start_when: null, client_type: 'new',
  raw_row_hash: 'h', needs_review: 0,
}, over);

// Seed opted-in audience (self-isolating).
upsertRegistration(mk({ raw_row_hash: 'A', whatsapp_norm: '97455511111', parent_first: 'Anna',  client_type: 'new',
  children_json: kids([{ first_name: 'Teen', last_name: '', dob: '1/1/2014' }]) })); // age ~12
upsertRegistration(mk({ raw_row_hash: 'B', whatsapp_norm: '97455522222', parent_first: 'Bader', client_type: 'existing',
  children_json: kids([{ first_name: 'Teen', last_name: '', dob: '1/1/2014' }, { first_name: 'Tot', last_name: '', dob: '1/1/2021' }]) })); // 12 + 5
upsertRegistration(mk({ raw_row_hash: 'E', whatsapp_norm: '97455566666', parent_first: 'Eman',  client_type: 'new',
  children_json: kids([{ first_name: 'Kid', last_name: '', dob: '1/1/2019' }]) })); // age ~7
upsertRegistration(mk({ raw_row_hash: 'C', whatsapp_norm: '97455533333', whatsapp_optin: 0 })); // excluded
upsertRegistration(mk({ raw_row_hash: 'D', whatsapp_norm: '97455544444', needs_review: 1 }));    // excluded

const regBefore = db.prepare('SELECT count(*) c FROM registrations').get().c;

const allSeg = { kind: 'all' };
const ageSeg = { kind: 'age', min: 10, max: 14 };
const allRec = resolveAudience(allSeg).recipients;
const ageRec = resolveAudience(ageSeg, { withChildren: true }).recipients;

console.log('=== buildPreview (all, EN) ===');
const pv = buildPreview({ text: 'Hello acro families', channel: 'telegram_test', segment: allSeg, lang: 'en', recipients: allRec });
console.log(pv.split('\n').slice(0, 8).join('\n'));
T('shows the typed message', pv.includes('Hello acro families'));
T('shows channel label (Telegram)', pv.includes('Telegram'));
T('shows recipient count 3', /Recipients: \*3\*/.test(pv));
T('shows masked phone 974•••••11', pv.includes('974•••••11'));
T('NO full number leaked', !pv.includes('97455511111'));
T('NO parent_last leaked (display_name = first only)', !pv.includes('HIDDENLAST'));
T('shows a recipient first name', pv.includes('Anna'));

console.log('\n=== buildPreview (empty audience) ===');
const pvEmpty = buildPreview({ text: 'x', channel: 'telegram_test', segment: { kind: 'client_type', value: 'nobody' }, lang: 'en', recipients: [] });
T('empty audience → "nothing to send"', /nothing to send/.test(pvEmpty));

console.log('\n=== buildDryRun (all, EN): FULL list ===');
const dr = buildDryRun({ segment: allSeg, lang: 'en', recipients: allRec });
T('dry-run lists ALL 3 recipients', (dr.match(/^• /gm) || []).length === 3);
T('dry-run masked, no full number', dr.includes('974•••••22') && !dr.includes('97455522222'));

console.log('\n=== age children_preview ===');
const pvAge = buildPreview({ text: 'camp', channel: 'telegram_test', segment: ageSeg, lang: 'en', recipients: ageRec });
console.log(pvAge.split('\n').slice(-3).join('\n'));
T('age band 10–14 → 2 recipients (A,B)', ageRec.length === 2);
T('children_preview shows child in band "Teen (12)" (MarkdownV2-escaped)', pvAge.includes('Teen \\(12\\)'));
T('child NOT in band (5yo Tot) not shown', !pvAge.includes('Tot'));

console.log('\n=== client_type segment label localised (reuses button labels) ===');
const ctypeSeg = { kind: 'client_type', value: 'new' };
const ctypeRec = resolveAudience(ctypeSeg).recipients;
const pvCtEn = buildPreview({ text: 'x', channel: 'telegram_test', segment: ctypeSeg, lang: 'en', recipients: ctypeRec });
const pvCtRu = buildPreview({ text: 'x', channel: 'telegram_test', segment: ctypeSeg, lang: 'ru', recipients: ctypeRec });
T('ctype label EN localised "Client type: New"', pvCtEn.includes('Client type: New'));
T('ctype label RU localised "Тип клиента: Новые"', pvCtRu.includes('Тип клиента: Новые'));
T('ctype value NOT raw "new"/"existing"', !pvCtEn.includes(': new') && !pvCtRu.includes('new'));

console.log('\n=== both languages render ===');
const pvRu = buildPreview({ text: 'Привет', channel: 'telegram_test', segment: allSeg, lang: 'ru', recipients: allRec });
T('EN preview title present', pv.includes('Broadcast preview'));
T('RU preview title present', pvRu.includes('Предпросмотр рассылки'));
T('enter_text EN carries the English-only reminder', /must be in English/.test(t('broadcast.enter_text', 'en')));
T('enter_text RU carries the reminder (на английском)', /на английском/.test(t('broadcast.enter_text', 'ru')));

console.log('\n=== formatter is read-only ===');
const regAfter = db.prepare('SELECT count(*) c FROM registrations').get().c;
T('registrations count unchanged by preview/dry-run', regAfter === regBefore);

console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
