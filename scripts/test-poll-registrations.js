'use strict';

/**
 * R4 — poller test (temp DB only). Runs processRows against the REAL form rows
 * (read-only) and proves: real inserts, idempotent re-run, per-row error
 * isolation (map_errors), and the heartbeat detail format.
 *
 *   rm -f /tmp/poll.db*
 *   sqlite3 data/acrogym.db ".backup '/tmp/poll.db'"   # consistent — captures WAL
 *   ACROGYM_DB_PATH=/tmp/poll.db node scripts/test-poll-registrations.js
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

const { getDb } = require('../shared/db');
const { writeHeartbeat, readHeartbeat } = require('../shared/heartbeat');
const { mapRow } = require('../shared/registrations/mapper');
const { processRows, readSheet } = require('./poll-registrations');

getDb(); // open temp + migrate

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { console.log('  ✅ ' + n); pass++; } else { console.log('  ❌ ' + n); fail++; } };

(async () => {
  const rows = await readSheet();            // read-only on the real form
  const headers = rows[0] || [];
  const data = rows.slice(1);
  console.log(`real form: ${headers.length} cols, ${data.length} rows\n`);

  console.log('=== first run (real rows → inserted; trailing blanks skipped) ===');
  const c1 = processRows(headers, data);
  console.log('  counts:', JSON.stringify(c1));
  const nonBlank = data.length - c1.blank;
  t('every non-blank row accounted for (inserted+skipped+blank=total)', c1.inserted + c1.skipped + c1.blank === c1.total);
  t('all non-blank rows inserted, none skipped on a fresh DB', c1.inserted === nonBlank && c1.skipped === 0);
  t('no map errors on real rows', c1.mapErrors === 0);

  console.log('=== second run (idempotent) ===');
  const c2 = processRows(headers, data);
  console.log('  counts:', JSON.stringify(c2));
  t('re-run: 0 inserted, all non-blank skipped', c2.inserted === 0 && c2.skipped === nonBlank && c2.blank === c1.blank);

  console.log('=== per-row error isolation (synthetic broken row) ===');
  // Inject one row that throws in the mapper; the rest must still process.
  const SENTINEL = '__BREAK__';
  const throwingMap = (h, v) => { if (v && v[0] === SENTINEL) throw new Error('synthetic map failure'); return mapRow(h, v); };
  const mixed = [[SENTINEL], ...data];
  const c3 = processRows(headers, mixed, { mapRow: throwingMap });
  console.log('  counts:', JSON.stringify(c3));
  t('broken row isolated → map_errors=1', c3.mapErrors === 1);
  t('other rows still processed (non-blank already inserted → skipped)', c3.skipped === nonBlank && c3.total === data.length + 1 && c3.blank === c1.blank);

  console.log('=== heartbeat carries counts ===');
  const detail = `ok, ${c1.total} rows, ${c1.inserted} new, ${c1.skipped} skipped, ${c1.review} review, ${c3.mapErrors} errors`;
  writeHeartbeat('registrations-poller', detail);
  const hb = readHeartbeat('registrations-poller');
  console.log('  heartbeats row:', hb && JSON.stringify({ agent_name: hb.agent_name, detail: hb.detail }));
  t('heartbeat written for registrations-poller', !!hb && hb.agent_name === 'registrations-poller');
  t('heartbeat detail carries counts (rows/new/errors)', hb && /\d+ rows/.test(hb.detail) && /\d+ errors/.test(hb.detail));

  console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
