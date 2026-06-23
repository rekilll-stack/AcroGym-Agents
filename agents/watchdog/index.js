'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const { createLogger } = require('../../shared/logger');
const { sendToOwner }  = require('../../shared/notify');
const {
  readHeartbeat,
  writeHeartbeat,
  getAlertState,
  setAlertState,
} = require('../../shared/heartbeat');

const logger   = createLogger('watchdog');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Qatar';

const TICK_MS = 60 * 1000; // check every minute
const PM2_BIN = process.env.PM2_BIN || 'pm2'; // override if pm2 isn't on PATH

// Auto-recovery: when an agent is "online but hung" (process alive, poll loop
// frozen — pm2 can't detect this), restart it automatically. Cooldown stops a
// restart loop if something is persistently broken: after one auto-restart we
// wait before trying again and keep alerting so a human can step in.
const RESTART_COOLDOWN_MS = Number(process.env.WATCHDOG_RESTART_COOLDOWN_MS) || 15 * 60 * 1000;
const lastAutoRestart = new Map(); // agent name → timestamp (in-memory; resets if watchdog restarts)

// Agents under watch. thresholdMs derived from real cycle intervals:
// both run a ~60s cycle → 3×60 + buffer ≈ 5 min. Better a 2-min-late alert
// than night-time false alarms that train us to ignore the channel.
const WATCHED = [
  { name: 'lead-helper', thresholdMs: 5 * 60 * 1000, kind: 'sheets' },
  { name: 'owner-bot',   thresholdMs: 5 * 60 * 1000, kind: 'telegram' },
  { name: 'content-bot', thresholdMs: 5 * 60 * 1000, kind: 'telegram' },
  // Cron agent (no pm2 process): judged by heartbeat freshness only. 30-min
  // cron → 70-min threshold tolerates one transient miss, catches a real
  // stall within the hour. pm2:false → no auto-restart (cron re-runs itself).
  { name: 'registrations-poller', thresholdMs: 70 * 60 * 1000, kind: 'cron', pm2: false },
];

// Backup dead-man's-switch: the daily cron drops a .db.gz into backups/daily/
// at 03:00. By the 09:00 ping today's file must be < 26h old. A missing or
// stale newest file means the backup silently didn't run — the cron never
// executed, so backup-db.js's own failure-alert never fired.
const BACKUP_DIR        = path.join(__dirname, '../../backups/daily');
const BACKUP_MAX_AGE_MS = 26 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-GB', {
    timeZone: TIMEZONE, day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtMins(ms) {
  return Math.round(ms / 60000);
}

function fmtHours(ms) {
  return Math.round(ms / 3600000);
}

/**
 * Newest .db.gz in backups/daily/ and whether it's fresh enough.
 * Returns { ok, ageMs, file } on success, or { ok:false, reason } when the
 * dir is missing/empty/stale — the dead-man's-switch signal.
 */
function backupFreshness() {
  let newest = null;
  try {
    for (const name of fs.readdirSync(BACKUP_DIR)) {
      if (!name.endsWith('.db.gz')) continue;
      const mtime = fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { name, mtime };
    }
  } catch (err) {
    return { ok: false, reason: 'no-dir', detail: err.message };
  }
  if (!newest) return { ok: false, reason: 'empty' };
  const ageMs = Date.now() - newest.mtime;
  return { ok: ageMs <= BACKUP_MAX_AGE_MS, ageMs, file: newest.name, reason: 'stale' };
}

/**
 * Returns a Map<name, {status, pmUptime, restarts}> from `pm2 jlist`.
 * On failure returns null so callers fall back to heartbeat-only mode.
 */
async function pm2Snapshot() {
  try {
    const { stdout } = await execFileP(PM2_BIN, ['jlist'], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    const list = JSON.parse(stdout);
    const map = new Map();
    for (const p of list) {
      const env = p.pm2_env || {};
      map.set(p.name, {
        status:    env.status || 'unknown',
        pmUptime:  env.pm_uptime || null,
        restarts:  env.restart_time || 0,
      });
    }
    return map;
  } catch (err) {
    logger.warn({ err: err.message }, 'pm2 jlist failed — heartbeat-only this tick');
    return null;
  }
}

/**
 * Evaluate one agent. Returns { problem: boolean, reason: string, detailHtml: string }.
 */
function evaluate(agent, hb, proc, now) {
  const ageMs   = hb && hb.last_ok_at ? now - hb.last_ok_at : Infinity;
  const isStale = ageMs > agent.thresholdMs;

  // 0) Cron agent (no pm2 process): judged by heartbeat freshness ALONE.
  // There is no process to inspect or restart — the cron re-runs itself, so a
  // stale heartbeat is reported as 'stale' (NOT 'hung' → tick() never auto-
  // restarts it). A missing heartbeat → ageMs=Infinity → also stale.
  if (agent.pm2 === false) {
    if (!isStale) return { problem: false, reason: 'ok', detailHtml: '' };
    // "Never ran" (no heartbeat → ageMs=Infinity) reads differently from
    // "ran, then went silent". Don't print "Infinity мин / с —".
    const everRan = hb && hb.last_ok_at;
    const head = everRan
      ? `Cron-агент молчит уже <b>${fmtMins(ageMs)} мин</b> (с ${fmtTime(hb.last_ok_at)}, порог ${fmtMins(agent.thresholdMs)} мин).`
      : `Cron-агент <b>ещё ни разу не отрабатывал</b> (heartbeat отсутствует, порог ${fmtMins(agent.thresholdMs)} мин).`;
    return {
      problem: true,
      reason: 'stale',
      detailHtml:
        `${head}\n` +
        `Нет pm2-процесса — крон должен перезапускать себя сам; проверь <code>crontab -l</code> и лог поллера.` +
        (everRan && hb.detail ? `\nПоследняя отметка: ${htmlEscape(hb.detail)}` : ''),
    };
  }

  // Process state (null proc = pm2 unavailable this tick)
  const status   = proc ? proc.status : 'unknown';
  const uptimeMs = proc && proc.pmUptime && status === 'online' ? now - proc.pmUptime : 0;
  const warmingUp = status === 'online' && uptimeMs > 0 && uptimeMs < agent.thresholdMs;

  // 1) Process not online (and pm2 known) → crashed / stopped
  if (proc && status !== 'online') {
    return {
      problem: true,
      reason: 'down',
      detailHtml:
        `Процесс в PM2: <b>${htmlEscape(status)}</b> — похоже упал или остановлен.\n` +
        `Последний успешный цикл: ${fmtTime(hb && hb.last_ok_at)}.`,
    };
  }

  // 2) Online but just (re)started → give it time to write the first heartbeat
  if (warmingUp && isStale) {
    return { problem: false, reason: 'warmup', detailHtml: '' };
  }

  // 3) Stale heartbeat → hung (process alive, cycles stopped) or pm2 unknown
  if (isStale) {
    const what = agent.kind === 'sheets'
      ? `Нет успешного цикла опроса Google Sheets уже <b>${fmtMins(ageMs)} мин</b>`
      : `Нет успешного цикла Telegram-probe уже <b>${fmtMins(ageMs)} мин</b>`;
    const procLine = proc
      ? `Процесс в PM2: <b>online</b> → завис (процесс жив, циклы стоят).`
      : `Статус процесса неизвестен (pm2 недоступен).`;
    return {
      problem: true,
      reason: 'hung',
      detailHtml:
        `${what} (с ${fmtTime(hb && hb.last_ok_at)}).\n${procLine}` +
        (hb && hb.detail ? `\nПоследняя отметка: ${htmlEscape(hb.detail)}` : ''),
    };
  }

  return { problem: false, reason: 'ok', detailHtml: '' };
}

async function alert(text) {
  try {
    await sendToOwner(text, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error({ err }, 'Failed to send watchdog alert');
  }
}

/**
 * Restart a hung agent via pm2. Returns true on success.
 */
async function restartAgent(name) {
  try {
    await execFileP(PM2_BIN, ['restart', name, '--update-env'], { timeout: 30000 });
    logger.warn({ agent: name }, 'auto-restart issued');
    return true;
  } catch (err) {
    logger.error({ err: err.message, agent: name }, 'auto-restart FAILED');
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Main tick
// ─────────────────────────────────────────────────────────────

async function tick() {
  const now  = Date.now();
  const snap = await pm2Snapshot();

  for (const agent of WATCHED) {
    let hb;
    try { hb = readHeartbeat(agent.name); }
    catch (err) { logger.error({ err, agent: agent.name }, 'readHeartbeat failed'); continue; }

    const proc = snap ? (snap.get(agent.name) || { status: 'not-found', pmUptime: null, restarts: 0 }) : null;
    const { problem, reason, detailHtml } = evaluate(agent, hb, proc, now);

    const prev = (getAlertState(agent.name) || {}).alert_state || 'ok';

    if (problem && prev === 'ok') {
      // Auto-recover a hung agent (process online but poll loop frozen — pm2
      // won't restart it on its own). Crashes ('down') are left to pm2.
      let restartNote = '';
      if (reason === 'hung') {
        const last = lastAutoRestart.get(agent.name) || 0;
        if (now - last >= RESTART_COOLDOWN_MS) {
          lastAutoRestart.set(agent.name, now);
          const ok = await restartAgent(agent.name);
          restartNote = ok
            ? '\n\n♻️ Авто-перезапуск выполнен — жду восстановления.'
            : '\n\n⚠️ Авто-перезапуск НЕ удался — нужен ручной рестарт.';
        } else {
          restartNote = '\n\n⚠️ Уже перезапускал недавно — авто-перезапуск пропущен, нужен ручной разбор.';
        }
      }
      await alert(`🔴 <b>${htmlEscape(agent.name)}</b> не отвечает\n${detailHtml}${restartNote}`);
      setAlertState(agent.name, 'alerting', now);
      logger.warn({ agent: agent.name, reason }, 'ALERT sent');
    } else if (!problem && prev === 'alerting') {
      const since = (getAlertState(agent.name) || {}).alerted_at || now;
      await alert(`✅ <b>${htmlEscape(agent.name)}</b> восстановлен (простой ~${fmtMins(now - since)} мин).`);
      setAlertState(agent.name, 'ok', now);
      logger.info({ agent: agent.name }, 'RECOVERED sent');
    }
    // problem && alerting → silent; ok && ok → silent
  }

  // Watchdog's own heartbeat (visibility / future self-monitoring)
  try { writeHeartbeat('watchdog', `tick ${snap ? 'pm2 ok' : 'pm2 down'}`); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────
// Daily "watchdog alive" ping — cheap insurance against a silently
// dead watchdog: absence of the morning ping is itself the signal.
// ─────────────────────────────────────────────────────────────

async function dailyPing() {
  const lines = ['✅ <b>watchdog жив</b>, агенты под наблюдением.'];
  for (const agent of WATCHED) {
    const hb  = (() => { try { return readHeartbeat(agent.name); } catch { return null; } })();
    const age = hb && hb.last_ok_at ? `${fmtMins(Date.now() - hb.last_ok_at)} мин назад` : 'нет данных';
    lines.push(`• ${htmlEscape(agent.name)}: последний ок ${age}`);
  }

  const bk = backupFreshness();
  if (bk.ok) {
    lines.push(`• бэкап БД: свежий (${htmlEscape(bk.file)}, ~${fmtHours(bk.ageMs)} ч назад)`);
  } else {
    lines.push('• бэкап БД: <b>🔴 устарел</b> (см. отдельную тревогу)');
  }
  await alert(lines.join('\n'));

  if (!bk.ok) {
    const why = bk.reason === 'empty'  ? 'в <code>backups/daily/</code> нет ни одного .db.gz'
              : bk.reason === 'no-dir' ? `папка <code>backups/daily/</code> недоступна (${htmlEscape(bk.detail || '')})`
              : `последний бэкап — <b>${htmlEscape(bk.file)}</b>, ему уже ~${fmtHours(bk.ageMs)} ч (порог 26 ч)`;
    await alert(
      `🔴 <b>Бэкап БД не выполнился</b>\n${why}.\n` +
      'Ночной крон (03:00) молча не отработал — проверь <code>crontab -l</code> и <code>logs/backup.log</code>.'
    );
    logger.warn({ reason: bk.reason, file: bk.file || null, ageMs: bk.ageMs || null }, 'backup dead-mans-switch ALERT');
  }
}

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────

function start() {
  logger.info({ tz: TIMEZONE, watched: WATCHED.map(a => a.name), pid: process.pid }, 'Watchdog starting');

  tick().catch(err => logger.error({ err }, 'tick unhandled'));
  setInterval(() => {
    tick().catch(err => logger.error({ err }, 'tick unhandled'));
  }, TICK_MS);

  cron.schedule('0 9 * * *', () => {
    dailyPing().catch(err => logger.error({ err }, 'dailyPing unhandled'));
  }, { timezone: TIMEZONE });

  logger.info('Watchdog running ✅ (tick 60s | daily ping + backup check 09:00)');
}

process.on('SIGTERM', () => { logger.info('SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { logger.info('SIGINT');  process.exit(0); });
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection');
});

if (require.main === module) {
  start();
}

module.exports = { evaluate, WATCHED };
