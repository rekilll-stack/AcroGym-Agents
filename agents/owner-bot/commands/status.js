'use strict';

const fs   = require('fs');
const path = require('path');

const dayjs = require('dayjs');
const utc   = require('dayjs/plugin/utc');
const tz    = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

const { createLogger }           = require('../../../shared/logger');
const { buildSystemStatus, formatUptime } = require('../builders/daily-builder');
const { t, createTranslator }    = require('../../../shared/i18n');
const { escapeMd }               = require('../../../shared/telegram');
const { getPreferredLanguage }   = require('../../../shared/preferences');

const logger   = createLogger('owner-bot');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Qatar';

module.exports = async function handleStatus(msg, bot) {
  const chatId = msg.chat.id;
  const lang   = getPreferredLanguage(chatId) || 'en';
  const tr     = createTranslator(lang);

  try {
    const pm2Status = buildSystemStatus();

    // DB size
    const dbPath = path.join(__dirname, '../../../data/acrogym.db');
    const dbSize = fs.existsSync(dbPath)
      ? `${(fs.statSync(dbPath).size / 1024).toFixed(1)} KB`
      : 'not found';

    // Disk free
    let diskFree = '?';
    try {
      const { execSync } = require('child_process');
      diskFree = execSync("df -h / | tail -1 | awk '{print $4}'", { encoding: 'utf8' }).trim();
    } catch {}

    // MarkdownV2 status message
    const now = dayjs().tz(TIMEZONE);
    const dateStr = escapeMd(`${now.format('D MMM YYYY HH:mm')} \(Doha\)`);

    let text = `${tr.t('status.title')}\n_${dateStr}_\n\n`;

    // Agents section
    text += `*${tr.t('status.section_agents')}*\n`;
    if (Array.isArray(pm2Status)) {
      for (const p of pm2Status) {
        const emoji = p.status === 'online' ? '🟢' : p.status === 'stopped' ? '🔴' : '🟡';
        const up    = p.uptime ? formatUptime(p.uptime, tr) : '?';
        text += tr.t('status.agent_line', {
          agent:    escapeMd(p.name),
          emoji,
          status:   escapeMd(p.status),
          uptime:   escapeMd(up),
          restarts: p.restarts,
          memory:   '—',
        }) + '\n';
      }
    } else {
      text += `• ⚠️ PM2 unavailable\n`;
    }

    // DB section
    text += `\n*${tr.t('status.section_db')}*\n`;
    text += tr.t('status.db_size', { size: escapeMd(dbSize) }) + '\n';

    // Disk section
    text += `\n*${tr.t('status.section_disk')}*\n`;
    text += tr.t('status.disk_free', { free: escapeMd(diskFree), total: '—' }) + '\n';

    const { backKeyboard } = require('../keyboards');
    await bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', reply_markup: backKeyboard(lang) });
  } catch (err) {
    logger.error({ err }, '/status command failed');
    await bot.sendMessage(chatId,
      `❌ Error: \`${escapeMd(err.message)}\``,
      { parse_mode: 'MarkdownV2' }
    );
  }
};
