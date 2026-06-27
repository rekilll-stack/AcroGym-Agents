'use strict';

/**
 * Encrypted secrets/config backup — one-shot, the "system independence" layer.
 *
 * The provider VPS snapshot already covers the whole machine, but it lives at the
 * SAME provider. This adds an INDEPENDENT, ENCRYPTED off-site copy of the bits
 * that are otherwise irreplaceable and not in any other backup: the secrets and
 * the server's reproducible config. Everything else already has an independent
 * copy (code/content/media → GitHub, DB → Telegram, leads → Google Sheets).
 *
 * 🔴 This archive CONTAINS SECRETS, so unlike backup-site.js it is gpg-encrypted
 * (AES256, symmetric) BEFORE it ever leaves the box. The passphrase lives in
 * .env as SYSTEM_BACKUP_PASSPHRASE *and* must be kept off-server by the owner —
 * without it the archive cannot be decrypted after the VPS is gone.
 *
 * Each run: stage the sensitive set → tar → gpg encrypt → restore-verify (a real
 * gpg decrypt + tar list) → send the .tar.gpg to the owner's Telegram → rotate.
 * Runs nightly from cron (03:45 Asia/Qatar). `--no-notify` skips the Telegram send.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const { createLogger } = require('../shared/logger');
const { sendToOwner, sendDocumentToOwner } = require('../shared/notify');

const logger    = createLogger('backup-secrets');
const TIMEZONE  = process.env.TIMEZONE || 'Asia/Qatar';
const NO_NOTIFY = process.argv.includes('--no-notify');
const PASSPHRASE = process.env.SYSTEM_BACKUP_PASSPHRASE || '';

const ROOT       = path.join(__dirname, '..');           // /home/admin/acrogym
const HOME       = os.homedir();                         // /home/admin
const DAILY_DIR  = path.join(ROOT, 'backups/secrets-daily');
const KEEP_DAILY = 14;

// The irreplaceable set — absolute paths. Missing entries are skipped (logged),
// never fatal, so the backup still runs if one file isn't there.
const SOURCES = [
  path.join(ROOT, '.env'),
  path.join(HOME, 'acrogym-admin/.env'),
  path.join(ROOT, 'config/google-service-account.json'),
  path.join(ROOT, 'data/canva-tokens.json'),
  path.join(HOME, '.ssh/acrogym_site_deploy'),
  path.join(HOME, '.ssh/acrogym_site_deploy.pub'),
  path.join(HOME, '.ssh/acrogym_bots_deploy'),
  path.join(HOME, '.ssh/acrogym_bots_deploy.pub'),
  path.join(HOME, '.ssh/acrogym_admin_deploy'),
  path.join(HOME, '.ssh/acrogym_admin_deploy.pub'),
  '/etc/nginx/sites-available',          // reproducible server config (world-readable)
];

// ── helpers ───────────────────────────────────────────────────
function stamp() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}`;
}
function htmlEscape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtSize(b) { if (b < 1024) return `${b} B`; const k = b / 1024; return k < 1024 ? `${k.toFixed(1)} KB` : `${(k / 1024).toFixed(1)} MB`; }
function captionTime() {
  return new Date().toLocaleString('en-GB', { timeZone: TIMEZONE, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
async function alert(text) {
  if (NO_NOTIFY) { logger.warn({ text }, 'alert suppressed (--no-notify)'); return; }
  try { await sendToOwner(text, { parse_mode: 'HTML' }); } catch (e) { logger.error({ err: e.message }, 'alert send failed'); }
}

// ── 1) staged tar + gpg encrypt ───────────────────────────────
async function snapshot() {
  if (!PASSPHRASE || PASSPHRASE.length < 16) {
    throw new Error('SYSTEM_BACKUP_PASSPHRASE missing/too short in .env — refusing to write an unprotected secrets archive');
  }
  fs.mkdirSync(DAILY_DIR, { recursive: true });

  const present = SOURCES.filter((p) => { const ok = fs.existsSync(p); if (!ok) logger.warn({ path: p }, 'source missing — skipped'); return ok; });
  if (!present.length) throw new Error('no source files present — nothing to back up');

  const name   = `acrogym-secrets-${stamp()}.tar.gpg`;
  const out     = path.join(DAILY_DIR, name);
  const tarArgs = ['cf', '-', ...present.map((p) => (path.isAbsolute(p) ? ['-C', '/', p.replace(/^\//, '')] : p)).flat()];

  // tar (stdout) → gpg symmetric AES256 (stdin) → out. Passphrase via fd, never argv.
  await new Promise((resolve, reject) => {
    const tar = execFile('tar', tarArgs, { maxBuffer: 64 * 1024 * 1024 });
    const gpg = execFile('gpg', [
      '--batch', '--yes', '--symmetric', '--cipher-algo', 'AES256',
      '--passphrase-fd', '0', '-o', out, '--no-symkey-cache',
    ]);
    let perr = '';
    // feed passphrase first, then pipe tar → gpg stdin
    gpg.stdin.write(PASSPHRASE + '\n');
    tar.stdout.pipe(gpg.stdin);
    tar.stderr.on('data', (d) => { const s = d.toString(); if (!/Removing leading|socket ignored|changed as we read/i.test(s)) perr += s; });
    gpg.stderr.on('data', (d) => { perr += d.toString(); });
    gpg.on('error', reject);
    gpg.on('close', (code) => code === 0 ? resolve() : reject(new Error(`gpg exit ${code}: ${perr.slice(-300)}`)));
  });

  fs.chmodSync(out, 0o600); // encrypted already, but keep the blob owner-only too
  const bytes = fs.statSync(out).size;
  logger.info({ file: name, bytes, files: present.length }, 'encrypted snapshot ok');
  return out;
}

// ── 2) restore-verify (real decrypt + tar list) ───────────────
async function restoreTest(gpgPath) {
  const { stdout } = await execFileP('bash', ['-c',
    `gpg --batch --quiet --decrypt --passphrase-fd 3 --no-symkey-cache 3<<<"$PP" "$1" | tar tf -`,
    'bash', gpgPath,
  ], { timeout: 60000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PP: PASSPHRASE } });
  const entries = stdout.split('\n').filter(Boolean);
  // must round-trip and contain the core secret
  if (!entries.some((p) => /acrogym\/\.env$/.test(p))) throw new Error('decrypt ok but archive missing acrogym/.env');
  logger.info({ entries: entries.length }, 'restore-verify ok (decrypt + list)');
  return entries.length;
}

// ── 3) off-site → owner Telegram ──────────────────────────────
async function sendOffsite(gpgPath, entries) {
  const buf  = fs.readFileSync(gpgPath);
  const name = path.basename(gpgPath);
  const caption = `🔐 AcroGym secrets backup (gpg AES256)\n${name}\n${captionTime()} Doha · ${fmtSize(buf.length)} · ${entries} files\nDecrypt needs SYSTEM_BACKUP_PASSPHRASE (kept off-server).`;
  const results = await sendDocumentToOwner(buf, name, caption, { parse_mode: null });
  const sent = Array.isArray(results) ? results.find((r) => r && r.message_id) : null;
  if (!sent) throw new Error('Telegram off-site: документ не принят (нет message_id)');
  logger.info({ file: name, message_id: sent.message_id }, 'off-site sent to Telegram');
  return sent.message_id;
}

function rotateLocal(dir, keep) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.tar.gpg')).sort().reverse();
  for (const f of files.slice(keep)) { fs.unlinkSync(path.join(dir, f)); logger.info({ file: f }, 'local rotation: deleted'); }
}

async function main() {
  const gpgPath = await snapshot();
  const entries = await restoreTest(gpgPath);
  let messageId = null;
  if (NO_NOTIFY) logger.warn('off-site send suppressed (--no-notify)');
  else messageId = await sendOffsite(gpgPath, entries);
  rotateLocal(DAILY_DIR, KEEP_DAILY);
  logger.info({ file: path.basename(gpgPath), offsite: messageId ? `Telegram ok (msg ${messageId})` : 'skipped', entries }, 'secrets backup complete ✅');
}

if (require.main === module) {
  main().catch(async (err) => {
    logger.error({ err }, 'secrets backup FAILED');
    await alert(`🔴 <b>Шифрованный бэкап секретов упал</b>\n<code>${htmlEscape(err.message)}</code>`);
    process.exit(1);
  });
}

module.exports = { snapshot, restoreTest, main };
