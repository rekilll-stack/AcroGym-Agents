'use strict';

// TODO ЭТАП 5: implement full monthly report via monthly-builder + PDF/PPTX
// Cron: '0 10 1 * *' (1st of month 10:00 Asia/Qatar) — registered in index.js

const { createLogger } = require('../../../shared/logger');
const { sendToOwner }  = require('../../../shared/notify');

const logger = createLogger('owner-bot');

async function sendMonthlyReport({ dryRun = false, lang = 'en' } = {}) {
  logger.info({ dryRun }, '[monthly] sendMonthlyReport — builder not yet implemented (ЭТАП 5)');
  if (!dryRun) {
    await sendToOwner('🗓 <b>Monthly Report</b>\n<i>Full monthly report with PDF/PPTX coming in ЭТАП 5.</i>').catch(() => {});
  }
}

module.exports = { sendMonthlyReport };
