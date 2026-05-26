'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');

const dayjs    = require('dayjs');
const utc      = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const { createLogger }  = require('../../shared/logger');
const { sendToOwner, sendMediaGroupToOwner } = require('../../shared/notify');
const {
  registerOwnerCallback,
  registerOwnerCommand,
  startOwnerPolling,
} = require('../../shared/telegram');
const { markRespondedHandler, copyTextHandler } = require('../../shared/callbacks');
const {
  getDb,
  getAllPending,
  countPending,
  countLeadsInRange,
  getLeadsByDay,
  getLeadsByDayRange,
  getLongPending,
} = require('../../shared/db');
const {
  buildDigest,
  buildSystemStatus,
  buildDayOfWeek,
  buildTimeOfDay,
  renderCharts,
} = require('./builder');

const logger   = createLogger('morning-digest');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Qatar';

const DRY_RUN    = process.argv.includes('--dry-run');
const WITH_CHARTS = process.argv.includes('--with-charts');
const TEST_SEND  = process.argv.includes('--test-send');

// ─────────────────────────────────────────────────────────────
// Core: send digest
// ─────────────────────────────────────────────────────────────

async function sendDigest({ withCharts = false, dryRun = false } = {}) {
  logger.info({ dryRun, withCharts }, 'Building digest...');

  let digest;
  try {
    digest = await buildDigest({ dryRun, withCharts });
  } catch (err) {
    logger.error({ err }, 'buildDigest failed');
    if (!dryRun) {
      await sendToOwner(`🚨 Morning-digest: build failed\n<code>${err.message}</code>`).catch(() => {});
    }
    return;
  }

  // ── DRY RUN ───────────────────────────────────────────────
  if (dryRun) {
    console.log('\n' + '═'.repeat(64));
    console.log('DRY RUN — main digest message:');
    console.log('═'.repeat(64));
    const plain = digest.text
      .replace(/<b>/g,'').replace(/<\/b>/g,'')
      .replace(/<i>/g,'').replace(/<\/i>/g,'')
      .replace(/<code>/g,'').replace(/<\/code>/g,'')
      .replace(/&gt;/g,'>');
    console.log(plain);
    console.log('═'.repeat(64));

    if (digest.allPending && digest.allPending.length > 0) {
      console.log(`\n📋 Would send pending list (${digest.allPending.length} leads) with inline buttons:`);
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
      // Save PNGs to /tmp for inspection
      const files = [];
      for (let i = 0; i < digest.chartBuffers.length; i++) {
        const p = `/tmp/digest-preview-chart${i + 1}.png`;
        fs.writeFileSync(p, digest.chartBuffers[i]);
        files.push({ path: p, size: digest.chartBuffers[i].length });
      }
      console.log('\nCharts saved to /tmp:');
      files.forEach(f => console.log(`  ${f.path}  (${Math.round(f.size / 1024)} KB)`));
    } else if (withCharts) {
      console.log('\nNo chart buffers returned (rendering failed or no data).');
    } else {
      console.log('\nWould send 3 charts as media group (use --with-charts to render).');
    }

    if (digest.insightText) {
      console.log(`\nInsight generated: "${digest.insightText}"`);
    } else {
      console.log('\nWould generate insight via Claude API.');
    }
    return;
  }

  // ── REAL SEND ─────────────────────────────────────────────

  // Part 1: main text message
  try {
    await sendToOwner(digest.text);
    logger.info('Digest main message sent');
  } catch (err) {
    logger.error({ err }, 'Failed to send main digest message');
  }

  // Part 2: all pending leads — one message with inline buttons per lead
  const now = dayjs().tz(TIMEZONE);
  if (digest.allPending && digest.allPending.length > 0) {
    try {
      const pending = digest.allPending;
      let listText  = `📋 <b>Pending leads (${pending.length})</b>\n\n`;

      const keyboard = [];
      for (let i = 0; i < pending.length; i++) {
        const lead = pending[i];
        const urgencyIcon = lead.urgency || '🕐';
        const phone       = lead.phone
          ? lead.phone.replace(/^(974)(\d{4})(\d{4})$/, '+$1 $2 $3')
          : '—';
        const greetIcon   = lead.hasGreeting ? '' : ' ✏️';

        listText += `${i + 1}. ${urgencyIcon} <b>${lead.name}</b>${greetIcon}\n`;
        listText += `    📱 ${phone} · ${lead.hoursWaiting}h waiting\n`;

        // Two buttons per row: [📋 Copy] [✅ Done]
        const shortName = lead.name.split(' ')[0].slice(0, 10);
        keyboard.push([
          { text: `📋 ${i + 1}. ${shortName}`, callback_data: `copy_text:${lead.id}` },
          { text: `✅ Done`,                    callback_data: `mark_responded:${lead.id}` },
        ]);
      }

      listText += '\n<i>🕐 &lt;8h  ⚠️ 8-24h  🚨 &gt;24h</i>';
      if (pending.some(l => !l.hasGreeting)) {
        listText += '\n<i>✏️ = no draft greeting stored</i>';
      }

      await sendToOwner(listText, { reply_markup: { inline_keyboard: keyboard } });
    } catch (err) {
      logger.error({ err }, 'Failed to send all-pending list');
    }
  }

  // Part 3: charts (if any)
  if (digest.chartBuffers.length > 0) {
    try {
      await sendMediaGroupToOwner(digest.chartBuffers, '📈 Trends for the past week');
      logger.info(`${digest.chartBuffers.length} chart(s) sent`);
    } catch (err) {
      logger.error({ err }, 'Failed to send charts');
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Bot commands (OWNER_BOT)
// ─────────────────────────────────────────────────────────────

async function handleYesterday(msg, bot) {
  const chatId = msg.chat.id;
  try {
    await bot.sendMessage(chatId, '⏳ Building yesterday\'s digest...', { parse_mode: 'HTML' });
    await sendDigest({ withCharts: false });
  } catch (err) {
    logger.error({ err }, '/yesterday command failed');
    await bot.sendMessage(chatId, `❌ Error: <code>${err.message}</code>`, { parse_mode: 'HTML' });
  }
}

async function handleWeek(msg, bot) {
  const chatId = msg.chat.id;
  try {
    await bot.sendMessage(chatId, '⏳ Building weekly report...', { parse_mode: 'HTML' });

    const now       = dayjs().tz(TIMEZONE);
    const thisStart = now.subtract(7,  'day').format('YYYY-MM-DD');
    const thisEnd   = now.subtract(1,  'day').format('YYYY-MM-DD');
    const prevStart = now.subtract(14, 'day').format('YYYY-MM-DD');
    const prevEnd   = now.subtract(8,  'day').format('YYYY-MM-DD');

    const thisWeek   = countLeadsInRange(thisStart, thisEnd);
    const prevWeek   = countLeadsInRange(prevStart, prevEnd);
    const longPnd    = getLongPending(24);
    const dayOfWeek  = buildDayOfWeek(7);

    let text = `📅 <b>Weekly Report</b>\n`;
    text    += `<i>${thisStart} → ${thisEnd}</i>\n\n`;
    text    += `📊 <b>This week:</b> ${thisWeek} leads\n`;
    text    += `📊 <b>Previous week:</b> ${prevWeek} leads\n`;

    if (prevWeek > 0) {
      const change = Math.round((thisWeek - prevWeek) / prevWeek * 100);
      const arrow  = change >= 0 ? '↗️' : '↘️';
      text += `📈 <b>Trend:</b> ${arrow} ${change >= 0 ? '+' : ''}${change}%\n`;
    }

    const bestDay = Object.entries(dayOfWeek).sort((a, b) => b[1] - a[1])[0];
    const worstDay = Object.entries(dayOfWeek).filter(([,v]) => v > 0).sort((a, b) => a[1] - b[1])[0];
    if (bestDay && bestDay[1] > 0) text += `\n🏆 Best day: ${bestDay[0]} (${bestDay[1]})\n`;
    if (worstDay && worstDay[0] !== bestDay[0]) text += `📉 Slowest day: ${worstDay[0]} (${worstDay[1]})\n`;

    if (longPnd.length > 0) {
      text += `\n🚨 <b>Long pending (&gt;24h):</b> ${longPnd.length} lead(s)\n`;
      longPnd.forEach(l => {
        const h = Math.floor((Date.now() - new Date(l.notified_at).getTime()) / 3600000);
        text += `• ${l.parent_name || '—'} — ${h}h\n`;
      });
    }

    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });

    // Weekly comparison chart
    const thisData = getLeadsByDay(7);
    const prevData = getLeadsByDayRange(prevStart, prevEnd);

    const labels    = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const thisMap   = Object.fromEntries(thisData.map(r => [dayjs(r.day).format('ddd'), r.cnt]));
    const prevMap   = Object.fromEntries(prevData.map(r => [dayjs(r.day).format('ddd'), r.cnt]));

    try {
      const { renderWeeklyComparison } = require('../../shared/chart');
      const chartBuf = await renderWeeklyComparison({
        title:         'This week vs previous week',
        labels,
        current_week:  labels.map(d => thisMap[d] || 0),
        previous_week: labels.map(d => prevMap[d] || 0),
      });
      await bot.sendPhoto(chatId, chartBuf, { caption: '📊 Weekly comparison chart' });
    } catch (chartErr) {
      logger.warn({ err: chartErr.message }, '/week chart rendering failed');
    }

  } catch (err) {
    logger.error({ err }, '/week command failed');
    await bot.sendMessage(chatId, `❌ Error: <code>${err.message}</code>`, { parse_mode: 'HTML' });
  }
}

async function handlePending(msg, bot) {
  const chatId = msg.chat.id;
  const parts  = (msg.text || '').trim().split(/\s+/);
  const offset = Math.max(0, (parseInt(parts[1], 10) || 1) - 1);
  const PAGE   = 20;

  try {
    const total = countPending();
    if (total === 0) {
      await bot.sendMessage(chatId, '✅ No pending leads right now.', { parse_mode: 'HTML' });
      return;
    }

    const leads = getAllPending(PAGE, offset);
    const now   = dayjs().tz(TIMEZONE);
    const from  = offset + 1;
    const to    = offset + leads.length;

    let text = `📋 <b>Pending leads ${from}–${to} of ${total}</b>\n\n`;

    const keyboard = [];
    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];
      const h    = now.diff(dayjs(lead.notified_at), 'hour');
      text += `${from + i}. ${lead.parent_name || '—'} — ${h}h | ${lead.parent_phone || '—'}\n`;
      // Rows of 2 buttons
      if (i % 2 === 0) {
        keyboard.push([{ text: `📋 Copy #${from + i}`, callback_data: `copy_text:${lead.id}` }]);
      } else {
        keyboard[keyboard.length - 1].push(
          { text: `📋 Copy #${from + i}`, callback_data: `copy_text:${lead.id}` }
        );
      }
    }

    if (to < total) {
      text += `\n<i>Showing ${from}–${to} of ${total}. Use /pending ${to + 1} to see more.</i>`;
    }

    await bot.sendMessage(chatId, text, {
      parse_mode:   'HTML',
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (err) {
    logger.error({ err }, '/pending command failed');
    await bot.sendMessage(chatId, `❌ Error: <code>${err.message}</code>`, { parse_mode: 'HTML' });
  }
}

async function handleStatus(msg, bot) {
  const chatId = msg.chat.id;
  try {
    const pm2Status = buildSystemStatus();
    const dbPath    = path.join(__dirname, '../../data/acrogym.db');
    const dbSize    = fs.existsSync(dbPath)
      ? `${(fs.statSync(dbPath).size / 1024).toFixed(1)} KB`
      : 'not found';

    // Disk usage
    let diskFree = '?';
    try {
      const { execSync } = require('child_process');
      const dfOut  = execSync("df -h / | tail -1 | awk '{print $4}'", { encoding: 'utf8' });
      diskFree = dfOut.trim();
    } catch {}

    let text = `🖥️ <b>System Status</b>\n<i>${dayjs().tz(TIMEZONE).format('D MMM YYYY HH:mm')} (Doha)</i>\n\n`;

    text += `<b>PM2 Processes:</b>\n`;
    if (Array.isArray(pm2Status)) {
      for (const p of pm2Status) {
        const icon = p.status === 'online' ? '🟢' : p.status === 'stopped' ? '🔴' : '🟡';
        const up   = p.uptime ? formatUptime(p.uptime) : '?';
        text += `• ${p.name}: ${icon} ${p.status} | uptime ${up} | PID ${p.pid} | restarts ${p.restarts}\n`;
      }
    } else {
      text += `• ⚠️ PM2 unavailable\n`;
    }

    text += `\n<b>Database:</b> ${dbSize}\n`;
    text += `<b>Disk free:</b> ${diskFree}\n`;

    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error({ err }, '/status command failed');
    await bot.sendMessage(chatId, `❌ Error: <code>${err.message}</code>`, { parse_mode: 'HTML' });
  }
}

function formatUptime(ms) {
  if (!ms || ms < 0) return '?';
  const totalH = Math.floor(ms / 3600000);
  const d = Math.floor(totalH / 24);
  const h = totalH % 24;
  if (d > 0) return `${d}d ${h}h`;
  return `${totalH}h`;
}

async function handleHelp(msg, bot) {
  const chatId = msg.chat.id;
  const text = `
🤸 <b>AcroGym Bot Commands</b>

/yesterday — Send today's digest right now
/week — Weekly leads report + comparison chart
/pending — List all unanswered leads (paginated)
/status — PM2 status, DB size, disk space
/help — This message
`.trim();
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

// ─────────────────────────────────────────────────────────────
// Setup callbacks & commands
// ─────────────────────────────────────────────────────────────

function setupCallbacksAndCommands() {
  // Callbacks from digest inline buttons (OWNER_BOT)
  registerOwnerCallback('mark_responded', markRespondedHandler('owner'));
  registerOwnerCallback('copy_text',      copyTextHandler());
  registerOwnerCallback('digest_copy',    copyTextHandler()); // legacy alias

  // Text commands (OWNER_BOT)
  registerOwnerCommand('/yesterday', handleYesterday);
  registerOwnerCommand('/week',      handleWeek);
  registerOwnerCommand('/pending',   handlePending);
  registerOwnerCommand('/status',    handleStatus);
  registerOwnerCommand('/help',      handleHelp);

  logger.info('Callbacks and commands registered');
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

async function start() {
  // ── One-shot modes ────────────────────────────────────────
  if (DRY_RUN) {
    logger.info({ withCharts: WITH_CHARTS }, 'DRY RUN mode');
    await sendDigest({ dryRun: true, withCharts: WITH_CHARTS });
    process.exit(0);
    return;
  }

  if (TEST_SEND) {
    logger.info('TEST SEND mode — sending real digest now');
    await sendDigest({ withCharts: true });
    logger.info('Test send complete');
    process.exit(0);
    return;
  }

  // ── Daemon mode ───────────────────────────────────────────
  logger.info({ timezone: TIMEZONE }, 'Morning-digest starting, waiting for 08:00 Asia/Qatar');

  setupCallbacksAndCommands();
  startOwnerPolling();

  // Daily digest at 08:00 Qatar time (with charts)
  cron.schedule('0 8 * * *', async () => {
    await sendDigest({ withCharts: true }).catch(err =>
      logger.error({ err }, 'sendDigest unhandled error')
    );
  }, { timezone: TIMEZONE });

  logger.info('Morning-digest running ✅ (next run at 08:00 AST, owner bot polling active)');
}

// ─────────────────────────────────────────────────────────────
// Process guards
// ─────────────────────────────────────────────────────────────

process.on('SIGTERM', () => { logger.info('SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { logger.info('SIGINT');  process.exit(0); });

process.on('uncaughtException', async (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  await sendToOwner(`🚨 Morning-digest crashed: <code>${err.message}</code>`).catch(() => {});
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection');
});

start().catch(async (err) => {
  logger.fatal({ err }, 'Failed to start morning-digest');
  process.exit(1);
});
