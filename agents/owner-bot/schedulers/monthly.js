'use strict';

/**
 * schedulers/monthly.js — отправка месячного отчёта.
 * Cron: '0 10 1 * *'  (1st of month 10:00 Asia/Qatar) — зарегистрирован в index.js.
 * CLI dry-run: node agents/owner-bot/index.js --monthly-dry-run [--lang ru]
 */

const { createLogger } = require('../../../shared/logger');
const { sendToOwner }  = require('../../../shared/notify');
const { escapeMd }     = require('../../../shared/telegram');
const { buildMonthlyReport } = require('../builders/monthly-builder');
const { backKeyboard } = require('../keyboards');

const logger = createLogger('owner-bot');

/**
 * Build and send the monthly report to owner(s).
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRun=false]
 * @param {string}  [opts.lang='en']
 * @param {string}  [opts.month]       — YYYY-MM; defaults to last calendar month
 */
async function sendMonthlyReport({ dryRun = false, lang = 'en', month } = {}) {
  logger.info({ dryRun, lang, month }, '[monthly] Building monthly report...');

  let report;
  try {
    report = await buildMonthlyReport({ lang, month, dryRun, hasAttachments: false });
  } catch (err) {
    logger.error({ err }, '[monthly] buildMonthlyReport failed');
    if (!dryRun) {
      await sendToOwner(
        `🚨 Owner\-bot: monthly report build failed\n\`${escapeMd(err.message)}\``
      ).catch(() => {});
    }
    return;
  }

  // ── DRY RUN ───────────────────────────────────────────────
  if (dryRun) {
    const sep = '═'.repeat(64);

    const plain = report.text
      .replace(/\\\\/g, '\\')
      .replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1')
      .replace(/\*/g, '')
      .replace(/_([^_]+)_/g, '$1');

    console.log(`\n${sep}\nMONTHLY DRY RUN (lang=${lang}):\n${sep}`);
    console.log(plain);
    console.log(sep);

    console.log('\nSections available for PDF/PPTX:');
    for (const [k, v] of Object.entries(report.sections)) {
      const avail = v.available === false ? '⚠️  placeholder (needs in2)' : '✓ data from DB';
      console.log(`  ${k.padEnd(12)} — ${avail}`);
    }
    console.log('\npdfBuffer:  null (TODO ЭТАП 7)');
    console.log('pptxBuffer: null (TODO ЭТАП 8)');
    return;
  }

  // ── REAL SEND ─────────────────────────────────────────────
  try {
    const results = await sendToOwner(report.text, { reply_markup: backKeyboard(lang) });
    if (results.length > 0) {
      logger.info('[monthly] Monthly report summary sent');
    } else {
      logger.error('[monthly] sendToOwner returned 0 results — Telegram likely rejected the message (MarkdownV2 parse error?)');
      await sendToOwner(
        '⚠️ Monthly report generated but failed to send \\(formatting error\\)\\. Check PM2 logs\\.',
      ).catch(() => {});
    }
  } catch (err) {
    logger.error({ err }, '[monthly] Failed to send monthly report');
  }

  // PDF/PPTX attachments — TODO ЭТАП 7/8
  if (report.pdfBuffer) {
    logger.info('[monthly] Would send PDF — not yet implemented');
  }
  if (report.pptxBuffer) {
    logger.info('[monthly] Would send PPTX — not yet implemented');
  }
}

module.exports = { sendMonthlyReport };
