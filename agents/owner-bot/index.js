'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

process.setMaxListeners(25); // many plugins + cron + guards = plenty of listeners

const cron = require('node-cron');

const { createLogger }  = require('../../shared/logger');
const {
  registerOwnerCommand,
  startOwnerPolling,
  getOwnerPollingErrorStats,
} = require('../../shared/telegram');
const { sendToOwner }      = require('../../shared/notify');
const { writeHeartbeat }   = require('../../shared/heartbeat');
const { gcExpiredStates }  = require('../../shared/state');
const { getPreferredLanguage } = require('../../shared/preferences');

// Test-only: freeze heartbeat writes to exercise the watchdog "hung" branch.
const HEARTBEAT_FROZEN = process.env.HEARTBEAT_FREEZE === '1';
const fs   = require('fs');
const path = require('path');

// Schedulers
const { sendDailyDigest }  = require('./schedulers/daily');
const { sendWeeklySlice }  = require('./schedulers/weekly');
const { sendMonthlyReport} = require('./schedulers/monthly');

// Commands
const handleMenu      = require('./commands/menu');
const handleYesterday = require('./commands/yesterday');
const handleWeek      = require('./commands/week');
const handleMonth     = require('./commands/month');
const handlePending   = require('./commands/pending');
const handleStatus    = require('./commands/status');
const handleHelp      = require('./commands/help');
const handleExport    = require('./commands/export');
const handleLang      = require('./commands/lang');
const handleNurture   = require('./commands/nurture');

// Callbacks
const { setupDigestCallbacks } = require('./callbacks/digest-callbacks');
const { setupMenuCallbacks }   = require('./callbacks/menu-callbacks');
const { setupExportCallbacks } = require('./callbacks/export-callbacks');
const { setupLangCallbacks }   = require('./callbacks/lang-callbacks');

const logger   = createLogger('owner-bot');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Qatar';

// Languages for scheduled owner reports, resolved from each owner's saved
// preference (user_preferences). 'both' or an unset preference falls back to
// both languages, so a fresh owner who hasn't chosen yet still gets the report.
// Union across owner chats: no owner ever misses their language.
function scheduledLangs() {
  const ids = (process.env.OWNER_CHAT_IDS || '')
    .split(',').map(s => Number(s.trim())).filter(Boolean);
  const langs = new Set();
  for (const id of ids) {
    const pref = getPreferredLanguage(id);
    if (pref === 'en' || pref === 'ru') langs.add(pref);
    else { langs.add('en'); langs.add('ru'); }
  }
  return langs.size ? [...langs] : ['en', 'ru'];
}

// ─────────────────────────────────────────────────────────────
// Single-instance lock (daemon mode only)
// ─────────────────────────────────────────────────────────────
const LOCK_FILE = path.join(__dirname, '../../data/owner-bot.lock');

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    const existingPid = parseInt(raw, 10);
    if (!isNaN(existingPid)) {
      try {
        process.kill(existingPid, 0); // throws ESRCH if dead
        console.error(`[owner-bot] Already running as PID ${existingPid}. Exiting.`);
        process.exit(1);
      } catch {
        // Stale lock — previous process is gone
        console.warn(`[owner-bot] Stale lock (PID ${existingPid} dead). Overwriting.`);
      }
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

const DRY_RUN          = process.argv.includes('--dry-run');
const WEEKLY_DRY_RUN   = process.argv.includes('--weekly-dry-run');
const MONTHLY_DRY_RUN  = process.argv.includes('--monthly-dry-run');
const WITH_CHARTS      = process.argv.includes('--with-charts');
const TEST_SEND        = process.argv.includes('--test-send');
const LANG_ARG         = (() => { const i = process.argv.indexOf('--lang'); return i >= 0 ? process.argv[i + 1] : 'en'; })();
const MONTH_ARG        = (() => { const i = process.argv.indexOf('--month'); return i >= 0 ? process.argv[i + 1] : undefined; })();

// ─────────────────────────────────────────────────────────────
// Unknown-input handler: anything not matching a command
// ─────────────────────────────────────────────────────────────
function registerUnknownInputHandler() {
  // Registered as catch-all via prefix '' — handled in telegram.js polling
  // For now we rely on command handlers; unknown text handler can be added later
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

async function start() {
  // ── One-shot modes ────────────────────────────────────────
  if (DRY_RUN) {
    logger.info({ withCharts: WITH_CHARTS, lang: LANG_ARG }, 'DRY RUN mode (daily)');
    await sendDailyDigest({ dryRun: true, withCharts: WITH_CHARTS, lang: LANG_ARG });
    process.exit(0);
    return;
  }

  if (WEEKLY_DRY_RUN) {
    logger.info({ withCharts: WITH_CHARTS, lang: LANG_ARG }, 'DRY RUN mode (weekly)');
    await sendWeeklySlice({ dryRun: true, withCharts: WITH_CHARTS, lang: LANG_ARG });
    process.exit(0);
    return;
  }

  if (MONTHLY_DRY_RUN) {
    logger.info({ lang: LANG_ARG, month: MONTH_ARG }, 'DRY RUN mode (monthly)');
    await sendMonthlyReport({ dryRun: true, lang: LANG_ARG, month: MONTH_ARG });
    process.exit(0);
    return;
  }

  if (TEST_SEND) {
    logger.info('TEST SEND mode — sending real digest now');
    await sendDailyDigest({ withCharts: true });
    logger.info('Test send complete');
    process.exit(0);
    return;
  }

  // ── Daemon mode ───────────────────────────────────────────
  acquireLock();
  logger.info({ timezone: TIMEZONE, pid: process.pid }, 'Owner-bot starting');

  // Register callbacks (must happen before startOwnerPolling)
  setupDigestCallbacks();
  setupMenuCallbacks();
  setupExportCallbacks();
  setupLangCallbacks();

  // Register text commands
  registerOwnerCommand('/menu',      handleMenu);
  registerOwnerCommand('/start',     handleMenu);
  registerOwnerCommand('/yesterday', handleYesterday);
  registerOwnerCommand('/week',      handleWeek);
  registerOwnerCommand('/month',     handleMonth);
  registerOwnerCommand('/pending',   handlePending);
  registerOwnerCommand('/status',    handleStatus);
  registerOwnerCommand('/export',    handleExport);
  registerOwnerCommand('/lang',      handleLang);
  registerOwnerCommand('/nurture',   handleNurture);
  registerOwnerCommand('/help',      handleHelp);

  // Start OWNER_BOT polling
  const ownerBot = startOwnerPolling();

  // ── Heartbeat probe: owner-bot is reactive (no work loop), so liveness is
  //    proven by an active getMe() probe every 60s. Success means event loop
  //    alive + Telegram API reachable + token valid. polling_error stats are
  //    folded into the detail so the watchdog can also see whether updates are
  //    actually arriving without errors. ──
  if (ownerBot) {
    const ownerProbe = async () => {
      try {
        await ownerBot.getMe();
        if (HEARTBEAT_FROZEN) return;
        const { count, lastAt } = getOwnerPollingErrorStats();
        const errPart = count === 0
          ? 'poll_err: 0'
          : `poll_err: ${count}, last ${new Date(lastAt).toLocaleTimeString('en-GB', { timeZone: TIMEZONE })}`;
        writeHeartbeat('owner-bot', `getMe ok; ${errPart}`);
      } catch (err) {
        logger.warn({ err }, 'owner-bot heartbeat probe failed (getMe)');
        // No heartbeat write — staleness lets the watchdog catch it.
      }
    };
    ownerProbe();
    setInterval(ownerProbe, 60 * 1000);
  }

  // ── Cron: daily digest 08:00 Asia/Qatar — owner's chosen language(s) ─
  cron.schedule('0 8 * * *', async () => {
    for (const lang of scheduledLangs()) {
      await sendDailyDigest({ withCharts: true, lang }).catch(err =>
        logger.error({ err, lang }, 'sendDailyDigest cron unhandled error')
      );
    }
  }, { timezone: TIMEZONE });

  // ── Cron: weekly slice 09:00 Monday — owner's chosen language(s) ────
  cron.schedule('0 9 * * 1', async () => {
    for (const lang of scheduledLangs()) {
      await sendWeeklySlice({ lang }).catch(err =>
        logger.error({ err, lang }, 'sendWeeklySlice cron unhandled error')
      );
    }
  }, { timezone: TIMEZONE });

  // ── Cron: monthly 10:00 1st of month — owner's chosen language(s) ───
  cron.schedule('0 10 1 * *', async () => {
    for (const lang of scheduledLangs()) {
      await sendMonthlyReport({ lang }).catch(err =>
        logger.error({ err, lang }, 'sendMonthlyReport cron unhandled error')
      );
    }
  }, { timezone: TIMEZONE });

  // ── GC: expired export states every 10 min ────────────────
  setInterval(() => {
    gcExpiredStates();
  }, 10 * 60 * 1000);

  // ── Cleanup: delete generated PDFs older than 24h (keep font-test-*) ──
  const EXPORTS_DIR = path.join(__dirname, '../../exports');
  setInterval(() => {
    try {
      if (!fs.existsSync(EXPORTS_DIR)) return;
      const now   = Date.now();
      const files = fs.readdirSync(EXPORTS_DIR);
      for (const file of files) {
        if (file.startsWith('font-test')) continue; // keep test files
        if (!file.endsWith('.pdf'))        continue;
        const fp   = path.join(EXPORTS_DIR, file);
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
          fs.unlinkSync(fp);
          logger.info({ file }, 'exports cleanup: deleted old PDF');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'exports cleanup failed');
    }
  }, 30 * 60 * 1000);

  logger.info('Owner-bot running ✅ (daily 08:00 | weekly Mon 09:00 | monthly 1st 10:00 | polling active)');
}

// ─────────────────────────────────────────────────────────────
// Process guards
// ─────────────────────────────────────────────────────────────

process.on('SIGTERM', () => { logger.info('SIGTERM'); releaseLock(); process.exit(0); });
process.on('SIGINT',  () => { logger.info('SIGINT');  releaseLock(); process.exit(0); });
process.on('exit',    ()  => { releaseLock(); });

process.on('uncaughtException', async (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  await sendToOwner(`🚨 Owner-bot crashed: <code>${err.message}</code>`).catch(() => {});
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection');
});

start().catch(async (err) => {
  logger.fatal({ err }, 'Failed to start owner-bot');
  await sendToOwner(`🚨 Owner-bot failed to start: <code>${err.message}</code>`).catch(() => {});
  process.exit(1);
});
