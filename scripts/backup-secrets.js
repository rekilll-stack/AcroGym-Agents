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
const SET = ((process.argv.find((a) => a.startsWith('--set=')) || '--set=secrets').split('=')[1]); /* 27.09: --set=code — исходники и данные, которых нет в GitHub (владелец: «у меня должна быть копия всего») */
const DAILY_DIR  = path.join(ROOT, SET === 'code' ? 'backups/code-daily' : SET === 'assets' ? 'backups/assets-weekly' : 'backups/secrets-daily');
const KEEP_DAILY = 14;

// The irreplaceable set — absolute paths. Missing entries are skipped (logged),
// never fatal, so the backup still runs if one file isn't there.
const SOURCES = [
  path.join(ROOT, '.env'),
  path.join(HOME, 'acrogym-admin/.env'),
  path.join(HOME, 'velantis/.env'),                      // доступ к базе Velantis и ключи интеграций
  path.join(HOME, 'velantis/.onboard-acrogym.json'),      // владелец зала и ключ API
  path.join(ROOT, 'config/google-service-account.json'),
  path.join(ROOT, 'data/canva-tokens.json'),
  path.join(HOME, '.ssh/acrogym_site_deploy'),
  path.join(HOME, '.ssh/acrogym_site_deploy.pub'),
  path.join(HOME, '.ssh/acrogym_bots_deploy'),
  path.join(HOME, '.ssh/acrogym_bots_deploy.pub'),
  path.join(HOME, '.ssh/acrogym_admin_deploy'),
  path.join(HOME, '.ssh/acrogym_admin_deploy.pub'),
  path.join(HOME, '.claude.json'),                        /* MCP-серверы с токенами (Я.Диск, in2 и др.) */
  path.join(HOME, '.claude/claude-oauth.env'),            /* годовой токен Claude Code */
  '/etc/nginx/sites-available',          // reproducible server config (world-readable)
];

// Набор «code»: код и данные вне GitHub. Секреты (.env) — в наборе secrets, здесь исключены.
const CODE_SOURCES = [
  path.join(HOME, 'velantis'), path.join(HOME, 'jarvis-mobile'), path.join(HOME, 'jarvis-mac'), path.join(HOME, 'mcp-servers'),
  ROOT, /* боты: в GitHub, но с незакоммиченными правками; data/ — базы лидов/почты (шифруется) */
  path.join(HOME, '.pm2/dump.pm2'), path.join(os.tmpdir(), 'acrogym-crontab.txt'), path.join(os.tmpdir(), 'acrogym-n8n-workflows.json'),
  path.join(HOME, '.claude/CLAUDE.md'), path.join(HOME, '.claude/settings.json'), path.join(HOME, '.claude/projects/-home-admin/memory'), /* правила, хуки и файловая память ассистента */
  path.join(HOME, 'bin'), path.join(HOME, '.config/systemd/user'), /* сторож лимита, юнит claude-tmux */
];
const CODE_EXCLUDES = ['node_modules', '.git', 'dist', 'build', '.gradle', '.tts-venv', 'emb-model', '*.apk', '*.aab', '*.tar.gz', '*.tgz', '*.tar.gpg', '*.dump', 'logs', '*.log', 'ms-playwright', '.cache', '.output', '.nuxt', 'web/preview', 'jarvis-bridge/reports', 'acrogym/backups', 'acrogym/assets/game', /* 420 МБ исходников графики игры — в еженедельной копии на Я.Диск */ '.env', '.env.*', '*.bak-*'];
const SRC = SET === 'code' ? CODE_SOURCES : SET === 'assets' ? [path.join(ROOT, 'assets/game')] : SOURCES, EXCL = SET === 'code' ? CODE_EXCLUDES : []; /* assets — раз в неделю: 420 МБ исходников графики игры */
const MUST = SET === 'code' ? /velantis\/src\/app\.js$/ : SET === 'assets' ? /assets\/game\/models\// : /acrogym\/\.env$/;

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
  if (!PASSPHRASE || PASSPHRASE.length < 10 /* 27.09: пароль выбрал владелец, 10 символов */) {
    throw new Error('SYSTEM_BACKUP_PASSPHRASE missing/too short in .env — refusing to write an unprotected secrets archive');
  }
  fs.mkdirSync(DAILY_DIR, { recursive: true });

  if (SET === 'code') { try { fs.writeFileSync(path.join(os.tmpdir(), 'acrogym-crontab.txt'), require('child_process').execSync('crontab -l').toString()); } catch (e) { logger.warn({ err: e.message }, 'crontab not captured'); } }
  if (SET === 'code') { /* воркфлоу n8n (поток лидов с сайта и Meta) живут в docker-томе — выгружаем через API */
    try { const r = await fetch('http://127.0.0.1:5678/api/v1/workflows?limit=100', { headers: { 'X-N8N-API-KEY': process.env.N8N_API_KEY || '' } }); const j = await r.json();
      if (!Array.isArray(j.data)) throw new Error('нет data'); fs.writeFileSync(path.join(os.tmpdir(), 'acrogym-n8n-workflows.json'), JSON.stringify(j.data, null, 1)); } catch (e) { logger.warn({ err: e.message }, 'n8n workflows not captured'); } }
  const present = SRC.filter((p) => { const ok = fs.existsSync(p); if (!ok) logger.warn({ path: p }, 'source missing — skipped'); return ok; });
  if (!present.length) throw new Error('no source files present — nothing to back up');

  const name   = `acrogym-${SET}-${stamp()}.tar.gpg`;
  const out     = path.join(DAILY_DIR, name);
  const tarArgs = ['cf', '-', ...EXCL.map((e) => '--exclude=' + e), ...present.map((p) => (path.isAbsolute(p) ? ['-C', '/', p.replace(/^\//, '')] : p)).flat()];

  // tar (stdout) → gpg symmetric AES256 (stdin) → out. Passphrase via fd, never argv.
  await new Promise((resolve, reject) => {
    const tar = require('child_process').spawn('tar', tarArgs); /* поток без буфера: у execFile потолок maxBuffer убивал tar на большом наборе code (27.09) */
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
  if (!entries.some((p) => MUST.test(p))) throw new Error('decrypt ok but archive missing ' + MUST);
  logger.info({ entries: entries.length }, 'restore-verify ok (decrypt + list)');
  return entries.length;
}

// ── 3) off-site → owner Telegram ──────────────────────────────
/* 27.09 владелец: «в Telegram больше не кидай» — копия вне сервера теперь на Яндекс.Диске /AcroGym/Backups/<вид>/ */
async function sendOffsite(gpgPath, entries) {
  const y = require('../shared/yadisk'), kind = SET === 'code' ? 'code' : SET === 'assets' ? 'weekly-game-assets' : 'secrets';
  const dest = await y.upload(gpgPath, kind); const rotated = await y.rotate(kind, SET === 'assets' ? 4 : 14);
  logger.info({ dest, entries, rotated }, 'off-site uploaded to Yandex.Disk');
  return dest;
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
  rotateLocal(DAILY_DIR, SET === 'assets' ? 1 : KEEP_DAILY);
  logger.info({ file: path.basename(gpgPath), offsite: messageId ? `Yandex.Disk ok (${messageId})` : 'skipped', entries }, 'secrets backup complete ✅');
}

if (require.main === module) {
  main().catch(async (err) => {
    logger.error({ err }, 'secrets backup FAILED');
    await alert(`🔴 <b>Шифрованный бэкап секретов упал</b>\n<code>${htmlEscape(err.message)}</code>`);
    process.exit(1);
  });
}

module.exports = { snapshot, restoreTest, main };
