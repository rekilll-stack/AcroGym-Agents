'use strict';

/**
 * schedulers/weekly.js — отправка недельного среза.
 * Cron: '0 9 * * 1'  (Monday 09:00 Asia/Qatar) — зарегистрирован в index.js.
 * CLI dry-run: node agents/owner-bot/index.js --weekly-dry-run [--with-charts]
 */

const fs = require('fs');

const { createLogger }                       = require('../../../shared/logger');
const { sendToOwner, sendMediaGroupToOwner } = require('../../../shared/notify');
const { escapeMd }                           = require('../../../shared/telegram');
const { buildWeeklySlice }                   = require('../builders/weekly-builder');
const { createTranslator }                   = require('../../../shared/i18n');
const { BACK_KB }                            = require('../keyboards');

const logger = createLogger('owner-bot');

/**
 * Build and send the weekly slice to owner(s).
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.withCharts=false]
 * @param {boolean} [opts.dryRun=false]
 * @param {string}  [opts.lang='en']
 */
async function sendWeeklySlice({ withCharts = false, dryRun = false, lang = 'en' } = {}) {
  logger.info({ dryRun, withCharts, lang }, '[weekly] Building weekly slice...');

  let slice;
  try {
    slice = await buildWeeklySlice({ lang, withCharts, dryRun });
  } catch (err) {
    logger.error({ err }, '[weekly] buildWeeklySlice failed');
    if (!dryRun) {
      await sendToOwner(
        `🚨 Owner\-bot: weekly slice build failed\n\`${escapeMd(err.message)}\``
      ).catch(() => {});
    }
    return;
  }

  // ── DRY RUN ───────────────────────────────────────────────
  if (dryRun) {
    const sep = '═'.repeat(64);

    // Strip MarkdownV2 formatting for readable console output
    const plain = slice.text
      .replace(/\\\\/g, '\\')
      .replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1')
      .replace(/\*/g, '')
      .replace(/_([^_]+)_/g, '$1');

    console.log(`\n${sep}\nWEEKLY DRY RUN (lang=${lang}):\n${sep}`);
    console.log(plain);
    console.log(sep);

    if (withCharts && slice.chartBuffers.length > 0) {
      for (let i = 0; i < slice.chartBuffers.length; i++) {
        const p = `/tmp/weekly-preview-chart${i + 1}.png`;
        fs.writeFileSync(p, slice.chartBuffers[i]);
        console.log(`  Chart ${i + 1} saved: ${p}  (${Math.round(slice.chartBuffers[i].length / 1024)} KB)`);
      }
    } else if (withCharts) {
      console.log('\nNo chart buffers returned (rendering failed or no data).');
    } else {
      console.log('\n(Use --with-charts to also render PNG charts.)');
    }

    if (slice.insightBilingual) {
      console.log(`\nInsight EN: "${slice.insightBilingual.en}"`);
      console.log(`Insight RU: "${slice.insightBilingual.ru}"`);
    } else {
      console.log('\nInsight: skipped in dry-run (would call Claude API on real send).');
    }
    return;
  }

  // ── REAL SEND ─────────────────────────────────────────────
  try {
    const results = await sendToOwner(slice.text, { reply_markup: BACK_KB });
    if (results.length > 0) {
      logger.info('[weekly] Weekly slice main message sent');
    } else {
      // sendToOwner catches parse errors internally — 0 results means all sends failed
      logger.error('[weekly] sendToOwner returned 0 results — Telegram likely rejected the message (MarkdownV2 parse error?)');
      await sendToOwner(
        '⚠️ Weekly slice generated but failed to send \\(formatting error\\)\\. Check PM2 logs\\.',
      ).catch(() => {});
    }
  } catch (err) {
    logger.error({ err }, '[weekly] Failed to send weekly slice message');
  }

  if (slice.chartBuffers.length > 0) {
    const tr = createTranslator(lang);
    try {
      await sendMediaGroupToOwner(slice.chartBuffers, tr.t('weekly.section_charts'));
      logger.info(`[weekly] ${slice.chartBuffers.length} chart(s) sent`);
    } catch (err) {
      logger.error({ err }, '[weekly] Failed to send weekly charts');
    }
  }
}

module.exports = { sendWeeklySlice };
