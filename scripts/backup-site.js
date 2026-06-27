'use strict';

/**
 * Site off-site backup — one-shot, mirrors scripts/backup-db.js.
 *
 * A SECOND, provider-independent copy of the website on top of the GitHub
 * mirror (the admin auto-pushes content+media to GitHub on publish). This guards
 * the cases GitHub alone can't: account compromise, accidental force-push, repo
 * deletion, GitHub being down exactly when we need to restore.
 *
 * Runs from system crontab (03:30 Asia/Qatar, after the DB backup). Each run:
 *   1) tar+gzip a SMALL, high-value snapshot:
 *        - acrogym-site SOURCE (code + app/content/site.json) — NOT the heavy
 *          media (public/img, public/video) or .git; media already lives in git.
 *        - acrogym-admin SOURCE + data/ (drafts, audit log, local site.json
 *          backups) — the admin is custom code that is otherwise single-copy.
 *      Secrets (.env) and node_modules/build output are excluded.
 *   2) restore-sanity: the archive must be gunzip-able, must contain the live
 *      site.json + admin server.js, and must NOT contain any .env — a snapshot
 *      that fails this is NOT trusted off-site.
 *   3) off-site copy: send the .tgz to the owner's Telegram chat as a document
 *      (reuses sendDocumentToOwner; the chat history is the off-site store).
 *   4) weekly copy on Sundays (local only) + rotation: 14 daily + 8 weekly local.
 *
 * Failure of any step → red Telegram alert. Success is quiet (logged).
 * `--no-notify` suppresses Telegram (for manual restore-tests).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const { createLogger } = require('../shared/logger');
const { sendToOwner, sendDocumentToOwner } = require('../shared/notify');

const logger    = createLogger('backup-site');
const TIMEZONE  = process.env.TIMEZONE || 'Asia/Qatar';
const NO_NOTIFY = process.argv.includes('--no-notify');

const ROOT       = path.join(__dirname, '..');          // /home/admin/acrogym
const HOME       = path.dirname(ROOT);                  // /home/admin
const SITE_REL   = 'acrogym-site';
const ADMIN_REL  = 'acrogym-admin';
const DAILY_DIR  = path.join(ROOT, 'backups/site-daily');
const WEEKLY_DIR = path.join(ROOT, 'backups/site-weekly');

const KEEP_DAILY  = 14;
const KEEP_WEEKLY = 8;

// Paths (archive-relative) the restore-sanity step requires / forbids.
const MUST_CONTAIN = [`${SITE_REL}/app/content/site.json`, `${ADMIN_REL}/server.js`];
const MUST_NOT_MATCH = /(^|\/)\.env$/m; // no secrets in the archive

// tar excludes — heavy media (already in git), build output, deps, git, secrets.
const EXCLUDES = [
  `${SITE_REL}/node_modules`, `${SITE_REL}/.nuxt`, `${SITE_REL}/.output`,
  `${SITE_REL}/dist`, `${SITE_REL}/.git`, `${SITE_REL}/public/img`,
  `${SITE_REL}/public/video`, `${SITE_REL}/.env`,
  `${ADMIN_REL}/node_modules`, `${ADMIN_REL}/.git`, `${ADMIN_REL}/.env`,
  `${ADMIN_REL}/data/*.log`,
];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function stamp() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}`;
}

function isSunday() {
  return new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'short' })
    .format(new Date()) === 'Sun';
}

function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

async function alert(text) {
  if (NO_NOTIFY) { logger.warn({ text }, 'alert suppressed (--no-notify)'); return; }
  try { await sendToOwner(text, { parse_mode: 'HTML' }); }
  catch (e) { logger.error({ err: e.message }, 'alert send failed'); }
}

// ─────────────────────────────────────────────────────────────
// 1) snapshot (tar + gzip)
// ─────────────────────────────────────────────────────────────
async function snapshot() {
  fs.mkdirSync(DAILY_DIR, { recursive: true });
  fs.mkdirSync(WEEKLY_DIR, { recursive: true });

  const name   = `acrogym-site-${stamp()}.tgz`;
  const out    = path.join(DAILY_DIR, name);
  const args   = ['czf', out, '-C', HOME, ...EXCLUDES.flatMap((e) => ['--exclude', e]), SITE_REL, ADMIN_REL];

  // tar exits 1 on "file changed as we read it" (harmless for a live tree); treat
  // only exit ≥2 as fatal. shell:false, fixed argv — no interpolation.
  try {
    await execFileP('tar', args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    if (typeof e.code === 'number' && e.code >= 2) throw new Error(`tar failed (exit ${e.code}): ${String(e.stderr || '').slice(-400)}`);
    logger.warn({ code: e.code }, 'tar reported a non-fatal change-during-read; continuing');
  }
  const bytes = fs.statSync(out).size;
  logger.info({ file: name, bytes }, 'snapshot + gzip ok');
  return out;
}

// ─────────────────────────────────────────────────────────────
// 2) restore-sanity (gunzip-able, has the key files, no secrets)
// ─────────────────────────────────────────────────────────────
async function restoreTest(gzPath) {
  const { stdout } = await execFileP('tar', ['tzf', gzPath], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  const entries = stdout.split('\n');

  for (const need of MUST_CONTAIN) {
    if (!entries.some((p) => p === need)) throw new Error(`archive missing required entry: ${need}`);
  }
  const leaked = entries.find((p) => MUST_NOT_MATCH.test(p));
  if (leaked) throw new Error(`archive contains a secret file: ${leaked}`);

  logger.info({ entries: entries.length }, 'restore-sanity ok');
  return entries.length;
}

// ─────────────────────────────────────────────────────────────
// 3) off-site → owner's Telegram chat
// ─────────────────────────────────────────────────────────────
async function sendOffsite(gzPath, entryCount) {
  const buf  = fs.readFileSync(gzPath);
  const name = path.basename(gzPath);
  const caption =
    `AcroGym site backup\n${name}\n${captionTime()} Doha · ${fmtSize(buf.length)} · ${entryCount} files · daily`;

  const results = await sendDocumentToOwner(buf, name, caption, { parse_mode: null });
  const sent = Array.isArray(results) ? results.find((r) => r && r.message_id) : null;
  if (!sent) throw new Error('Telegram off-site: документ не принят (нет message_id)');
  logger.info({ file: name, message_id: sent.message_id }, 'off-site sent to Telegram');
  return sent.message_id;
}

function rotateLocal(dir, keep) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.tgz')).sort().reverse();
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

  const gzPath = await snapshot();
  const entryCount = await restoreTest(gzPath);

  let messageId = null;
  if (NO_NOTIFY) {
    logger.warn('off-site send suppressed (--no-notify)');
  } else {
    messageId = await sendOffsite(gzPath, entryCount);
  }

  if (weekly) {
    fs.copyFileSync(gzPath, path.join(WEEKLY_DIR, path.basename(gzPath)));
    logger.info({ file: path.basename(gzPath) }, 'weekly copy ok');
  }

  rotateLocal(DAILY_DIR, KEEP_DAILY);
  rotateLocal(WEEKLY_DIR, KEEP_WEEKLY);

  logger.info({ file: path.basename(gzPath), weekly, offsite: messageId ? `Telegram ok (msg ${messageId})` : 'skipped', entries: entryCount }, 'site backup complete ✅');
}

if (require.main === module) {
  main().catch(async (err) => {
    logger.error({ err }, 'site backup FAILED');
    await alert(
      `🔴 <b>Бэкап сайта упал</b>\n<code>${htmlEscape(err.message)}</code>\n` +
      'Снимок не гарантирован — проверь VPS.'
    );
    process.exit(1);
  });
}

module.exports = { snapshot, restoreTest, main };
