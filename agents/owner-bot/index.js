'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

process.setMaxListeners(25); // many plugins + cron + guards = plenty of listeners

const cron = require('node-cron');

const { createLogger }  = require('../../shared/logger');
const {
  registerOwnerCommand,
  startOwnerPolling,
} = require('../../shared/telegram');
const { sendToOwner } = require('../../shared/notify');

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

// Callbacks
const { setupDigestCallbacks } = require('./callbacks/digest-callbacks');
const { setupMenuCallbacks }   = require('./callbacks/menu-callbacks');
const { setupExportCallbacks } = require('./callbacks/export-callbacks');

const logger   = createLogger('owner-bot');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Qatar';

const DRY_RUN    = process.argv.includes('--dry-run');
const WITH_CHARTS = process.argv.includes('--with-charts');
const TEST_SEND  = process.argv.includes('--test-send');

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
    logger.info({ withCharts: WITH_CHARTS }, 'DRY RUN mode');
    await sendDailyDigest({ dryRun: true, withCharts: WITH_CHARTS });
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
  logger.info({ timezone: TIMEZONE }, 'Owner-bot starting');

  // Register callbacks (must happen before startOwnerPolling)
  setupDigestCallbacks();
  setupMenuCallbacks();
  setupExportCallbacks();

  // Register text commands
  registerOwnerCommand('/menu',      handleMenu);
  registerOwnerCommand('/start',     handleMenu);
  registerOwnerCommand('/yesterday', handleYesterday);
  registerOwnerCommand('/week',      handleWeek);
  registerOwnerCommand('/month',     handleMonth);
  registerOwnerCommand('/pending',   handlePending);
  registerOwnerCommand('/status',    handleStatus);
  registerOwnerCommand('/export',    handleExport);
  registerOwnerCommand('/help',      handleHelp);

  // Start OWNER_BOT polling
  startOwnerPolling();

  // ── Cron: daily digest 08:00 Asia/Qatar ──────────────────
  cron.schedule('0 8 * * *', async () => {
    await sendDailyDigest({ withCharts: true }).catch(err =>
      logger.error({ err }, 'sendDailyDigest cron unhandled error')
    );
  }, { timezone: TIMEZONE });

  // ── Cron: weekly slice 09:00 Monday Asia/Qatar ───────────
  cron.schedule('0 9 * * 1', async () => {
    await sendWeeklySlice({}).catch(err =>
      logger.error({ err }, 'sendWeeklySlice cron unhandled error')
    );
  }, { timezone: TIMEZONE });

  // ── Cron: monthly report 10:00 1st of month Asia/Qatar ───
  cron.schedule('0 10 1 * *', async () => {
    await sendMonthlyReport({}).catch(err =>
      logger.error({ err }, 'sendMonthlyReport cron unhandled error')
    );
  }, { timezone: TIMEZONE });

  logger.info('Owner-bot running ✅ (daily 08:00 | weekly Mon 09:00 | monthly 1st 10:00 | polling active)');
}

// ─────────────────────────────────────────────────────────────
// Process guards
// ─────────────────────────────────────────────────────────────

process.on('SIGTERM', () => { logger.info('SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { logger.info('SIGINT');  process.exit(0); });

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
