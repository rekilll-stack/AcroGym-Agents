'use strict';

const fs   = require('fs');
const dayjs = require('dayjs');
const utc   = require('dayjs/plugin/utc');
const tz    = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

const { createLogger }                       = require('../../../shared/logger');
const { sendToOwner, sendMediaGroupToOwner } = require('../../../shared/notify');
const { escapeMd }                           = require('../../../shared/telegram');
const { buildDigest }                        = require('../builders/daily-builder');
const { createTranslator }                   = require('../../../shared/i18n');
const { BACK_KB }                            = require('../keyboards');

const logger   = createLogger('owner-bot');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Qatar';

/**
 * Build and send the daily digest to owner(s).
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.withCharts=false]
 * @param {boolean} [opts.dryRun=false]
 * @param {string}  [opts.lang='en']
 */
async function sendDailyDigest({ withCharts = false, dryRun = false, lang = 'en' } = {}) {
  logger.info({ dryRun, withCharts, lang }, '[daily] Building digest...');

  let digest;
  try {
    digest = await buildDigest({ dryRun, withCharts, lang });
  } catch (err) {
    logger.error({ err }, '[daily] buildDigest failed');
    if (!dryRun) {
      await sendToOwner(`🚨 Owner\-bot: digest build failed\n\`${escapeMd(err.message)}\``).catch(() => {});
    }
    return;
  }

  const tr = createTranslator(lang);

  // ── DRY RUN ───────────────────────────────────────────────
  if (dryRun) {
    const sep = '═'.repeat(64);

    // Strip MarkdownV2 formatting for console preview
    const plain = digest.text
      .replace(/\\\\/g, '\\')
      .replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1') // unescape MDv2
      .replace(/\*/g, '')
      .replace(/_([^_]+)_/g, '$1');

    console.log(`\n${sep}\nDRY RUN (lang=${lang}) — main digest message:\n${sep}`);
    console.log(plain);
    console.log(sep);

    if (digest.allPending && digest.allPending.length > 0) {
      console.log(`\n📋 Would send pending list (${digest.allPending.length} leads):`);
      for (const l of digest.allPending) {
        const icon = l.urgency || '🕐';
        console.log(`  ${icon} ${l.name} | ${l.hoursWaiting}h | ${l.phone || '—'}${l.hasGreeting ? '' : ' ✏️'}`);
      }
    } else {
      console.log('\n✅ No pending leads.');
    }

    if (digest.yesterdayResponded && digest.yesterdayResponded.length > 0) {
      console.log(`\n✅ Yesterday responded (${digest.yesterdayResponded.length}):`);
      digest.yesterdayResponded.forEach(r => console.log(`  ${r.name} at ${r.respondedAt}`));
    }

    if (digest.longPending.length > 0) {
      console.log(`\n🚨 Long pending (>24h): ${digest.longPending.length} lead(s)`);
    }

    if (withCharts && digest.chartBuffers.length > 0) {
      for (let i = 0; i < digest.chartBuffers.length; i++) {
        const p = `/tmp/digest-preview-chart${i + 1}.png`;
        fs.writeFileSync(p, digest.chartBuffers[i]);
        console.log(`  Chart saved: ${p}  (${Math.round(digest.chartBuffers[i].length / 1024)} KB)`);
      }
    } else if (withCharts) {
      console.log('\nNo chart buffers returned (rendering failed or no data).');
    } else {
      console.log('\nWould send charts as media group (use --with-charts to render).');
    }

    if (digest.insightText) console.log(`\nInsight: "${digest.insightText}"`);
    else                    console.log('\nWould generate insight via Claude API.');
    return;
  }

  // ── REAL SEND ─────────────────────────────────────────────

  // Part 1: main text (MarkdownV2)
  try {
    const results = await sendToOwner(digest.text, { reply_markup: BACK_KB });
    if (results.length > 0) {
      logger.info('[daily] Digest main message sent');
    } else {
      logger.error('[daily] sendToOwner returned 0 results — Telegram likely rejected the message (MarkdownV2 parse error?)');
      await sendToOwner(
        '⚠️ Daily digest generated but failed to send \\(formatting error\\)\\. Check PM2 logs\\.',
      ).catch(() => {});
    }
  } catch (err) {
    logger.error({ err }, '[daily] Failed to send main digest message');
  }

  // Part 2: pending leads with inline buttons (MarkdownV2)
  if (digest.allPending && digest.allPending.length > 0) {
    try {
      const pending  = digest.allPending;
      // Section header (already bold from i18n)
      let listText = tr.t('daily.section_pending_top') + '\n\n';
      const keyboard = [];

      for (let i = 0; i < pending.length; i++) {
        const lead = pending[i];
        const phone = lead.phone ? lead.phone.replace(/^(974)(\d{4})(\d{4})$/, '+$1 $2 $3') : '—';
        const greetIcon = lead.hasGreeting ? '' : ' ✏️';

        listText += tr.t('daily.pending_card', { n: i + 1, hours: lead.hoursWaiting }) + greetIcon + '\n';
        listText += tr.t('daily.pending_name',  { name:  escapeMd(lead.name) }) + '\n';
        listText += tr.t('daily.pending_phone', { phone: escapeMd(phone) }) + '\n\n';

        keyboard.push([
          { text: tr.t('daily.btn_copy_text'),       callback_data: `copy_text:${lead.id}` },
          { text: tr.t('daily.btn_mark_responded'),  callback_data: `mark_responded:${lead.id}` },
        ]);
      }

      keyboard.push(BACK_KB.inline_keyboard[0]); // append "⬅ Back to menu" row
      await sendToOwner(listText, { reply_markup: { inline_keyboard: keyboard } });
      logger.info({ count: pending.length }, '[daily] Pending list sent');
    } catch (err) {
      logger.error({ err }, '[daily] Failed to send pending list');
    }
  }

  // Part 3: charts (caption safe — no special chars)
  if (digest.chartBuffers.length > 0) {
    try {
      await sendMediaGroupToOwner(digest.chartBuffers, tr.t('daily.charts_caption'));
      logger.info(`[daily] ${digest.chartBuffers.length} chart(s) sent`);
    } catch (err) {
      logger.error({ err }, '[daily] Failed to send charts');
    }
  }
}

module.exports = { sendDailyDigest };
