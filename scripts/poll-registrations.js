'use strict';

/**
 * Registrations poller (R4) — projects the big enrollment form into the
 * `registrations` table. Runs on a schedule (cron — added in R5).
 *
 * Boundaries:
 *  - Sheet is READ-ONLY (spreadsheets.readonly), via its OWN service-account
 *    client (isolated from shared/sheets.js / the lead pipeline).
 *  - Writes ONLY to `registrations` (upsertRegistration). Never the sheet,
 *    never leads / the canonical table.
 *  - A failed sheet read writes NOTHING and exits non-zero (no heartbeat → it
 *    goes stale → the R5 watchdog dead-man's-switch alerts).
 *  - Per-row errors are isolated (counted as map_errors), the run continues.
 *  - On success: heartbeat 'registrations-poller' carries the counts.
 */

const { google } = require('googleapis');
const { mapRow } = require('../shared/registrations/mapper');
const { upsertRegistration } = require('../shared/db');
const { writeHeartbeat } = require('../shared/heartbeat');
const { createLogger } = require('../shared/logger');

const logger = createLogger('reg-poller');

const SHEET_ID = process.env.REGISTRATION_SHEET_ID || '1SL94orhjzIsUa86-Uln-GC-B5v0AtiuAF-UQ1uL6Zgs';
const TAB      = process.env.REGISTRATION_TAB || 'Form Responses 1';

/** Read the whole responses tab via a dedicated read-only SA client. */
async function readSheet() {
  const auth = new google.auth.GoogleAuth({
    keyFile: './config/google-service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: TAB });
  return r.data.values || [];
}

/**
 * Map + upsert each data row, isolating per-row errors. Pure-ish (deps injectable
 * for testing). Returns counts.
 */
function processRows(headers, dataRows, deps = {}) {
  const map    = deps.mapRow || mapRow;
  const upsert = deps.upsertRegistration || upsertRegistration;
  let inserted = 0, skipped = 0, review = 0, blank = 0, mapErrors = 0;

  dataRows.forEach((values, i) => {
    try {
      const reg = map(headers, values);
      // Trailing blank sheet rows are not submissions — skip, don't store.
      if (!reg.submitted_at && !reg.parent_first && !reg.whatsapp_norm && !reg.mobile_norm) { blank++; return; }
      if (reg.needs_review) review++;
      const res = upsert(reg);
      if (res.action === 'inserted') inserted++; else skipped++;
    } catch (err) {
      mapErrors++;
      logger.warn({ err: err.message, row: i + 2 }, 'row failed — isolated, continuing');
    }
  });

  return { total: dataRows.length, inserted, skipped, review, blank, mapErrors };
}

async function main() {
  let rows;
  try {
    rows = await readSheet();
  } catch (err) {
    // No writes, no heartbeat — stale heartbeat is the R5 dead-man's signal.
    logger.error({ err: err.message }, 'sheet read failed — no writes, exiting');
    process.exit(1);
  }

  const headers  = rows[0] || [];
  const dataRows = rows.slice(1);
  const c = processRows(headers, dataRows);

  const detail = `ok, ${c.total} rows, ${c.inserted} new, ${c.skipped} skipped, ${c.blank} blank, ${c.review} review, ${c.mapErrors} errors`;
  try { writeHeartbeat('registrations-poller', detail); }
  catch (err) { logger.warn({ err: err.message }, 'heartbeat write failed'); }

  logger.info(c, detail);
  console.log(detail);
}

if (require.main === module) {
  main().catch(err => { logger.error({ err: err.message }, 'poller crashed'); process.exit(1); });
}

module.exports = { processRows, readSheet, SHEET_ID, TAB };
