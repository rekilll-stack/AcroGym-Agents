'use strict';

/**
 * SQLite backup — one-shot, isolated from the watchdog process.
 *
 * Runs from system crontab (03:00 Asia/Qatar). Each run:
 *   1) consistent snapshot via `sqlite3 .backup` (never `cp` — WAL is live)
 *   2) gzip
 *   3) restore-test: gunzip into a throwaway DB, integrity_check + core counts
 *      vs the live DB — a snapshot that fails this is NOT trusted off-site
 *   4) off-site copy: send the .gz to the owner's Telegram chat as a document
 *      (reuses sendDocumentToOwner / OWNER_BOT_TOKEN). The chat history is the
 *      off-site store — no service-account Drive/GCS quota wall, no extra config.
 *   5) weekly copy on Sundays (local only)
 *   6) rotation: 14 daily + 8 weekly, LOCAL only (Telegram history is kept as-is
 *      — more restore points, not fewer)
 *
 * Failure of any step → red Telegram alert to the owner. Success is quiet
 * (logged only). `--no-notify` suppresses Telegram (for manual restore-tests).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const Database = require('better-sqlite3');
const { createLogger } = require('../shared/logger');
const { sendToOwner, sendDocumentToOwner } = require('../shared/notify');

const logger   = createLogger('backup');
const TIMEZONE  = process.env.TIMEZONE || 'Asia/Qatar';
const NO_NOTIFY = process.argv.includes('--no-notify');

const ROOT        = path.join(__dirname, '..');
const DB_PATH     = path.join(ROOT, 'data/acrogym.db');
const DAILY_DIR   = path.join(ROOT, 'backups/daily');
const WEEKLY_DIR  = path.join(ROOT, 'backups/weekly');

const KEEP_DAILY  = 14;
const KEEP_WEEKLY = 8;

// Tables that mutate on a sub-minute cadence (telemetry/heartbeats) — reported
// but not failed on, since the live DB can change between snapshot and compare.
const VOLATILE = new Set(['logs', 'heartbeats', 'watchdog_state', 'user_state']);

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function stamp() {
  // YYYY-MM-DD-HHMM in Qatar time, for filenames
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}`;
}

function isSunday() {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'short' })
    .format(new Date());
  return wd === 'Sun';
}

function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function alert(text) {
  logger.warn({ alert: text }, 'backup alert');
  if (NO_NOTIFY) return;
  try { await sendToOwner(text, { parse_mode: 'HTML' }); }
  catch (err) { logger.error({ err }, 'failed to send backup alert'); }
}

function tableCounts(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all().map(r => r.name);
    const out = {};
    for (const n of names) {
      out[n] = db.prepare(`SELECT COUNT(*) c FROM "${n}"`).get().c;
    }
    return out;
  } finally {
    db.close();
  }
}

// ─────────────────────────────────────────────────────────────
// Steps
// ─────────────────────────────────────────────────────────────

async function snapshot() {
  fs.mkdirSync(DAILY_DIR, { recursive: true });
  fs.mkdirSync(WEEKLY_DIR, { recursive: true });

  const base    = `acrogym-${stamp()}.db`;
  const rawPath = path.join(DAILY_DIR, base);
  const gzPath  = `${rawPath}.gz`;

  // 1) consistent snapshot (no shell → no quoting needed)
  await execFileP('sqlite3', [DB_PATH, `.backup ${rawPath}`], { timeout: 60000 });

  // 2) gzip, then drop the raw copy
  const gz = zlib.gzipSync(fs.readFileSync(rawPath));
  fs.writeFileSync(gzPath, gz);
  fs.unlinkSync(rawPath);

  logger.info({ file: base + '.gz', bytes: gz.length }, 'snapshot + gzip ok');
  return gzPath;
}

/**
 * Restore-test: gunzip into a throwaway DB, integrity_check, and compare core
 * (non-volatile) table counts against the live DB. Returns a result summary or
 * throws on a hard failure (corruption / core mismatch).
 */
function restoreTest(gzPath) {
  const tmp = path.join(ROOT, `data/_restore-test-${process.pid}.db`);
  try {
    fs.writeFileSync(tmp, zlib.gunzipSync(fs.readFileSync(gzPath)));

    const integ = new Database(tmp, { readonly: true })
      .pragma('integrity_check', { simple: true });
    if (integ !== 'ok') {
      throw new Error(`integrity_check = ${integ}`);
    }

    const restored = tableCounts(tmp);
    const live     = tableCounts(DB_PATH);

    const mismatches = [];
    for (const t of Object.keys(live)) {
      if (VOLATILE.has(t)) continue;
      if (restored[t] !== live[t]) {
        mismatches.push(`${t}: snapshot=${restored[t]} live=${live[t]}`);
      }
    }
    if (mismatches.length) {
      throw new Error(`core count mismatch — ${mismatches.join('; ')}`);
    }

    const core = Object.keys(live).filter(t => !VOLATILE.has(t))
      .map(t => `${t}=${restored[t]}`).join(', ');
    logger.info({ core }, 'restore-test ok');
    return core;
  } finally {
    try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch (_) {}
  }
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

function captionTime() {
  return new Date().toLocaleString('en-GB', {
    timeZone: TIMEZONE, day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Off-site = send the .gz to the owner's Telegram chat as a document. Success
 * is proven by a real Telegram response carrying a message_id; an empty result
 * (sendDocumentToOwner swallows per-chat send errors) is treated as failure so
 * it surfaces via the 🔴 path. Returns the message_id.
 */
async function sendOffsite(gzPath) {
  const buf     = fs.readFileSync(gzPath);
  const name    = path.basename(gzPath);
  const caption =
    `AcroGym DB backup\n${name}\n${captionTime()} Doha · ${fmtSize(buf.length)} · daily backup`;

  // parse_mode:null → plain-text caption, no parser to break on stray chars.
  const results = await sendDocumentToOwner(buf, name, caption, { parse_mode: null });

  const sent = Array.isArray(results) ? results.find(r => r && r.message_id) : null;
  if (!sent) {
    throw new Error('Telegram off-site: документ не принят (нет message_id в ответе sendDocument)');
  }
  logger.info({ file: name, message_id: sent.message_id }, 'off-site sent to Telegram');
  return sent.message_id;
}

function rotateLocal(dir, keep) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.db.gz')).sort().reverse();
  for (const f of files.slice(keep)) {
    fs.unlinkSync(path.join(dir, f));
    logger.info({ file: f }, 'local rotation: deleted');
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  const weekly = isSunday();

  // 1-2) snapshot + gzip
  const gzPath = await snapshot();

  // 3) restore-test — a failure here means the snapshot is NOT trustworthy
  const core = restoreTest(gzPath);

  // 4) off-site → owner's Telegram chat (one document per run; weekly is local
  //    rotation only, not re-sent). Throws on no message_id → 🔴 path.
  const messageId = await sendOffsite(gzPath);

  // 5) weekly copy (local only)
  if (weekly) {
    const weeklyGz = path.join(WEEKLY_DIR, path.basename(gzPath));
    fs.copyFileSync(gzPath, weeklyGz);
    logger.info({ file: path.basename(weeklyGz) }, 'weekly copy ok');
  }

  // 6) local rotation (Telegram history is kept as-is — no off-site rotation)
  rotateLocal(DAILY_DIR, KEEP_DAILY);
  rotateLocal(WEEKLY_DIR, KEEP_WEEKLY);

  logger.info({ file: path.basename(gzPath), weekly, offsite: `Telegram ok (msg ${messageId})`, core }, 'backup complete ✅');
}

// Guard: only run when invoked directly (`node scripts/backup-db.js`), so a
// stray require() in a test can't fire a real backup + Telegram alert.
if (require.main === module) {
  main().catch(async (err) => {
    logger.error({ err }, 'backup FAILED');
    await alert(
      `🔴 <b>Бэкап БД упал</b>\n<code>${htmlEscape(err.message)}</code>\n` +
      'Снимок не гарантирован — проверь VPS.'
    );
    process.exit(1);
  });
}

module.exports = { snapshot, restoreTest, main };
