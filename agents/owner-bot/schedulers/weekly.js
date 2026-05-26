'use strict';

// TODO ЭТАП 4: implement full weekly slice via weekly-builder
// Cron: '0 9 * * 1' (Monday 09:00 Asia/Qatar) — registered in index.js

const { createLogger } = require('../../../shared/logger');
const { sendToOwner }  = require('../../../shared/notify');

const logger = createLogger('owner-bot');

async function sendWeeklySlice({ dryRun = false, lang = 'en' } = {}) {
  logger.info({ dryRun }, '[weekly] sendWeeklySlice — builder not yet implemented (ЭТАП 4)');
  if (!dryRun) {
    await sendToOwner('📅 <b>Weekly Slice</b>\n<i>Full weekly report coming in ЭТАП 4.</i>').catch(() => {});
  }
}

module.exports = { sendWeeklySlice };
