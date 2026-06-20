'use strict';

/**
 * Test of the registrations header mapper.
 *  - SYNTHETIC edge cases (offline, deterministic): prove needs_review triggers
 *    and the "first non-empty / OR" dedup actually fire — catches a future break
 *    in child grouping or branch handling.
 *  - REAL form run (READ-ONLY via the service account): maps the live rows.
 * Writes NOTHING (no DB, no sheet). Masks names/phones/emails in output.
 *
 *   node scripts/test-registrations-mapper.js
 */

const { google } = require('googleapis');
const { mapRow } = require('../shared/registrations/mapper');

const SHEET_ID = '1SL94orhjzIsUa86-Uln-GC-B5v0AtiuAF-UQ1uL6Zgs';
const TAB = 'Form Responses 1';

const mPhone = (v) => v ? String(v).slice(0, 3) + '***' + String(v).slice(-2) : v;
const mName  = (v) => v ? String(v)[0] + '***' : v;
const mEmail = (v) => v ? String(v).slice(0, 2) + '***@' + String(v).split('@')[1] : v;

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { console.log('  ✅ ' + n); pass++; } else { console.log('  ❌ ' + n); fail++; } };

// ── Synthetic headers mirroring the real branchy form (simplified) ──
const H = [
  'Timestamp', 'Email Address', 'First Name (Parent/Guardian)', 'Last Name (Parent/Guardian)',
  'Mobile Number', 'How many children are you registering?',
  'Child 1 - First Name', 'Child 1 - Last Name', 'Child 1 - Date of Birth', '  Acceptance  ',
  'Child 1 - First Name', 'Child 1 - Last Name', 'Child 1 - Date of Birth',
  'Child 2 - First Name', 'Child 2 - Last Name', 'Child 2 - Date of Birth',
  'Child 3 - First Name', 'Child 3 - Last Name', 'Child 3 - Date of Birth', '  Acceptance  ',
  'WhatsApp Number', 'WhatsApp notifications (optional)',
];
const blank = () => Array(H.length).fill('');

function syntheticTests() {
  console.log('=== synthetic: needs_review triggers ===');
  let v = blank(); v[0] = '1/1/2026'; v[2] = 'Anna'; v[4] = '50001111'; v[5] = '3';
  v[10] = 'Kid1'; v[12] = '1/1/2018'; v[13] = 'Kid2'; v[15] = '1/1/2020'; // child 3 empty
  let r = mapRow(H, v); let cap = JSON.parse(r.children_json);
  t('declared 3 / filled 2 → needs_review=1 (count mismatch)', r.needs_review === 1 && cap.children.length === 2 && cap.declared_count === 3);

  v = blank(); v[0] = '1/1/2026'; v[2] = 'Bob'; v[5] = '1'; v[6] = 'Kid'; v[8] = '1/1/2019';
  r = mapRow(H, v);
  t('no phone → needs_review=1', r.needs_review === 1 && !r.whatsapp_norm && !r.mobile_norm);

  v = blank(); v[0] = '1/1/2026'; v[4] = '50002222'; v[5] = '1'; v[6] = 'Kid'; v[8] = '1/1/2019';
  r = mapRow(H, v);
  t('no parent name → needs_review=1', r.needs_review === 1 && !r.parent_first);

  v = blank(); v[0] = '1/1/2026'; v[2] = 'Cara'; v[4] = '50003333'; v[5] = '1';
  v[6] = 'KidA'; v[8] = '1/1/2019'; v[10] = 'KidB'; v[12] = '1/1/2020'; // two blocks filled
  r = mapRow(H, v);
  t('two blocks filled → needs_review=1 (multiBlock)', r.needs_review === 1);

  v = blank(); v[0] = '1/1/2026'; v[2] = 'Eve'; v[4] = '50005555'; v[5] = '1'; v[6] = 'Kid'; v[8] = '1/1/2019';
  r = mapRow(H, v);
  t('clean row → needs_review=0', r.needs_review === 0);

  console.log('=== synthetic: first-non-empty / OR (duplicate Acceptance) ===');
  v = blank(); v[0] = '1/1/2026'; v[2] = 'Dan'; v[4] = '50004444'; v[5] = '1'; v[6] = 'Kid'; v[8] = '1/1/2019';
  v[9] = ''; v[19] = 'I agree to T&C (V1)'; // 1st Acceptance empty, 2nd filled
  r = mapRow(H, v);
  t('Acceptance 1st empty / 2nd filled → tc_accepted=1', r.tc_accepted === 1);

  console.log('=== synthetic: opt-in (non-empty = consent) ===');
  v = blank(); v[0] = '1/1/2026'; v[2] = 'Eve'; v[4] = '50005555'; v[5] = '1'; v[6] = 'Kid'; v[8] = '1/1/2019';
  v[21] = 'I agree to receive WhatsApp notifications';
  r = mapRow(H, v);
  t('opt-in cell non-empty → optin=1 + optin_at + version', r.whatsapp_optin === 1 && r.optin_at === '1/1/2026' && r.optin_version === 'wa_v1');
  v[21] = ''; r = mapRow(H, v);
  t('opt-in cell empty → optin=0, optin_at null', r.whatsapp_optin === 0 && r.optin_at === null);

  console.log('=== synthetic: whatsapp_norm priority (WhatsApp Number → Mobile) ===');
  v = blank(); v[0] = '1/1/2026'; v[2] = 'Fay'; v[4] = '50006666'; v[5] = '1'; v[6] = 'K'; v[8] = '1/1/2019'; v[20] = '66009999';
  r = mapRow(H, v);
  t('WhatsApp Number present → whatsapp_norm from it', r.whatsapp_norm === '97466009999' && r.mobile_norm === '97450006666');
  v[20] = ''; r = mapRow(H, v);
  t('no WhatsApp Number → fallback to Mobile', r.whatsapp_norm === '97450006666');

  console.log('=== synthetic: hash ignores junk tail ===');
  const base = blank(); base[0] = '1/1/2026'; base[2] = 'Gil'; base[4] = '50007777'; base[5] = '1'; base[6] = 'K'; base[8] = '1/1/2019';
  const withJunk = [...base, 'some junk in a trailing Column 49'];
  t('junk tail does not change hash', mapRow(H, base).raw_row_hash === mapRow([...H, 'Column 49'], withJunk).raw_row_hash);
}

async function realRun() {
  const auth = new google.auth.GoogleAuth({
    keyFile: './config/google-service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!A1:BZ7` });
  const rows = r.data.values || [];
  const headers = rows[0] || [];
  const dataRows = rows.slice(1);

  console.log(`\n=== real form (read-only): ${headers.length} cols, ${dataRows.length} rows ===`);
  let optinAll0 = true, hashStable = true;

  dataRows.forEach((values, idx) => {
    const reg = mapRow(headers, values);
    if (mapRow(headers, values).raw_row_hash !== reg.raw_row_hash) hashStable = false;
    if (reg.whatsapp_optin !== 0) optinAll0 = false;
    const cap = JSON.parse(reg.children_json);
    const trig = [];
    if (!reg.whatsapp_norm && !reg.mobile_norm) trig.push('no-phone');
    if (cap.needs_review) trig.push('children-unparsed');
    if (!reg.parent_first) trig.push('no-parent-name');
    console.log(`── row ${idx + 2}: ${mName(reg.parent_first)} ${mName(reg.parent_last)} | wa ${mPhone(reg.whatsapp_norm)} | optin ${reg.whatsapp_optin} | client ${reg.client_type} | children ${reg.children_count}/${cap.declared_count} | review ${reg.needs_review}${trig.length ? ' (' + trig.join(',') + ')' : ''}`);
    (cap.children || []).forEach((c, i) => console.log(`      child ${i + 1}: ${mName(c.first_name)} | dob ${c.dob || '—'}${c.needs_review ? ' ⚠️' : ''}`));
  });

  t('legacy whatsapp_optin all 0', optinAll0);
  t('hash stable on real rows', hashStable);
}

(async () => {
  syntheticTests();
  await realRun();
  console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
