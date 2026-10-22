/* Пересчёт photo_consent по реальным ответам формы (Yes/No). Разовый бэкфилл после фикса mapper.js 08.09.
   Ключ сопоставления — id регистрации (первая колонка формы). Запуск: node scripts/backfill-photo-consent.js [--go] */
require('dotenv').config();
const { google } = require('googleapis');
const Database = require('better-sqlite3');
const { mapRow } = require('../shared/registrations/mapper');
const GO = process.argv.includes('--go');
const SHEET = process.env.REGISTRATION_SHEET_ID || '1SL94orhjzIsUa86-Uln-GC-B5v0AtiuAF-UQ1uL6Zgs';
(async () => {
  const auth = new google.auth.GoogleAuth({ keyFile: 'config/google-service-account.json', scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sh = google.sheets({ version: 'v4', auth: await auth.getClient() });
  const meta = await sh.spreadsheets.get({ spreadsheetId: SHEET }); const tab = meta.data.sheets[0].properties.title;
  const rows = (await sh.spreadsheets.values.get({ spreadsheetId: SHEET, range: `'${tab}'!A1:BZ2000` })).data.values || [];
  const hs = rows[0] || [], cols = hs.map((h, i) => [String(h).toLowerCase(), i]).filter(([h]) => h.includes('photographed') || h.includes('social media')).map(([, i]) => i);
  if (!cols.length) { console.error('не нашёл вопрос про фото'); process.exit(1); }
  /* в форме нет колонки id — сопоставляем по raw_row_hash, который считает тот же mapper (он и создавал записи) */
  const db = new Database('data/acrogym.db', { readonly: !GO });
  /* ⚠️ photo_consent входит в raw_row_hash: после фикса mapper у «No»-семей отпечаток другой. Обновляем и его,
     иначе поллер сочтёт эти строки новыми и создаст дубли регистраций. */
  const upd = GO ? db.prepare('UPDATE registrations SET photo_consent=?, raw_row_hash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?') : null;
  db.pragma('busy_timeout = 8000');
  let yes = 0, no = 0, none = 0, changed = 0, missing = 0;
  const byHash = db.prepare('SELECT id, photo_consent, raw_row_hash FROM registrations WHERE raw_row_hash=?');
  const byKey = db.prepare('SELECT id, photo_consent, raw_row_hash FROM registrations WHERE submitted_at=? AND mobile_norm IS ?'); /* стабильный ключ: время отправки + телефон */
  for (const r of rows.slice(1)) {
    let reg; try { reg = mapRow(hs, r); } catch (_) { continue; }
    if (!reg || !reg.raw_row_hash) continue;
    const consent = reg.photo_consent;
    const ans = cols.map((i) => String((r || [])[i] || '').trim()).filter(Boolean);
    if (!ans.length) none++; else if (consent) yes++; else no++;
    const cur = byHash.get(reg.raw_row_hash) || byKey.get(reg.submitted_at, reg.mobile_norm || null);
    if (!cur) { missing++; continue; }
    if (cur.photo_consent !== consent || cur.raw_row_hash !== reg.raw_row_hash) { changed++; if (GO) upd.run(consent, reg.raw_row_hash, cur.id); }
  }
  console.log(JSON.stringify({ mode: GO ? 'ЗАПИСЬ' : 'проверка', yes, no, noAnswer: none, changed, notInDb: missing }));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
