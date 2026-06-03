'use strict';

const { createLogger } = require('../../../shared/logger');
const nurture          = require('../../../shared/nurture');

const logger = createLogger('owner-bot');

/**
 * /nurture — manually trigger the Phase-1 nurture run: enroll newly-eligible
 * leads, push the queue to the admins, and reply with the execution summary.
 * The ✅ Sent buttons on those cards are handled by lead-helper (it polls the
 * Admin bot); here we only kick off the run and report.
 */
module.exports = async function handleNurture(msg, bot) {
  const chatId = msg.chat.id;
  try {
    const enroll = nurture.enrollEligibleLeads();
    const queue  = await nurture.buildAndSendQueue();
    const summary = nurture.buildOwnerSummaryText();

    await bot.sendMessage(
      chatId,
      `✅ <b>Nurture run triggered</b>\n` +
      `Newly enrolled: <b>${enroll.enrolled}</b>\n` +
      `Queued to admins: <b>${queue.queued}</b>\n\n${summary}`,
      { parse_mode: 'HTML' }
    );
    logger.info({ enrolled: enroll.enrolled, queued: queue.queued }, '/nurture run complete');
  } catch (err) {
    logger.error({ err }, '/nurture command failed');
    await bot.sendMessage(chatId, `❌ Nurture error: <code>${err.message}</code>`, { parse_mode: 'HTML' })
      .catch(() => {});
  }
};
