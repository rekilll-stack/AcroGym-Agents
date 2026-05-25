'use strict';

const dayjs = require('dayjs');
const utc      = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const {
  getDailyStats,
  getTopUnanswered,
  countLeadsInRange,
} = require('../../shared/db');

const TIMEZONE     = process.env.TIMEZONE || 'Asia/Qatar';
const OPENING_DATE = '2026-09-01';

const LANG_FLAGS = { RU: '🇷🇺', EN: '🇬🇧', AR: '🇶🇦' };

const RU_DAYS = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
const RU_MONTHS = ['января','февраля','марта','апреля','мая','июня',
                   'июля','августа','сентября','октября','ноября','декабря'];

function formatDate(d) {
  return `${d.date()} ${RU_MONTHS[d.month()]} ${d.year()} (${RU_DAYS[d.day()]})`;
}

function formatPhone(phone) {
  if (!phone) return '—';
  return phone.replace(/(\d{3})(\d+)$/, (_, a, b) => `${a} ${'X'.repeat(b.length)}`);
}

/**
 * Строит текст дайджеста на основе данных из БД.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]  - если true, добавляем пометку [DRY RUN]
 * @returns {Promise<{ text: string, copyCallbacks: object[] }>}
 *   copyCallbacks — данные для inline-кнопок "скопировать текст лида"
 */
async function buildDigest({ dryRun = false } = {}) {
  const now       = dayjs().tz(TIMEZONE);
  const yesterday = now.subtract(1, 'day');

  // UTC-диапазон для "вчера" в Qatar time
  const startUtc = yesterday.startOf('day').utc().format('YYYY-MM-DD HH:mm:ss');
  const endUtc   = yesterday.endOf('day').utc().format('YYYY-MM-DD HH:mm:ss');
  const yesterdayStr = yesterday.format('YYYY-MM-DD');

  // ── Статистика за вчера ──
  const stats = getDailyStats(yesterdayStr);

  const byType = {};
  for (const { client_type, cnt } of stats.byType) byType[client_type] = cnt;

  const byLang = {};
  for (const { language, cnt } of stats.byLang) byLang[language] = cnt;

  const newCount      = byType['new']      || 0;
  const existingCount = byType['existing'] || 0;
  const returningCount= byType['returning']|| 0;
  const unknownCount  = byType['unknown']  || 0;
  const totalCount    = newCount + existingCount + returningCount + unknownCount;

  // ── Неотвеченные ──
  const topUnanswered = getTopUnanswered(3);
  const oldestUnanswered = topUnanswered[0] || null;

  // ── Тренд недели ──
  const last7Start  = now.subtract(7, 'day').format('YYYY-MM-DD');
  const last7End    = yesterday.format('YYYY-MM-DD');
  const prev7Start  = now.subtract(14, 'day').format('YYYY-MM-DD');
  const prev7End    = now.subtract(8, 'day').format('YYYY-MM-DD');

  const last7Count = countLeadsInRange(last7Start, last7End);
  const prev7Count = countLeadsInRange(prev7Start, prev7End);
  const hasTrendData = last7Count > 0 || prev7Count > 0;

  // ── Прогноз до открытия ──
  const opening      = dayjs(OPENING_DATE).tz(TIMEZONE);
  const daysLeft     = opening.diff(now.startOf('day'), 'day');
  const avgPerDay    = last7Count > 0 ? (last7Count / 7) : 0;
  const projected    = Math.round(avgPerDay * daysLeft);

  // Статус прогноза: нужно 300 учеников, целевая конверсия ~26%
  const TARGET_STUDENTS = 300;
  const TARGET_CONV     = 0.26;
  const neededLeads     = Math.round(TARGET_STUDENTS / TARGET_CONV);
  let forecastStatus = '🔴 отстаём';
  if (projected >= neededLeads) forecastStatus = '🟢 в графике';
  else if (projected >= neededLeads * 0.7) forecastStatus = '🟡 средне';

  // ─────────────────────────────────────────────────────────────
  // Сборка текста
  // ─────────────────────────────────────────────────────────────

  const dryRunMark = dryRun ? '\n<i>[DRY RUN — не отправляется в Telegram]</i>' : '';

  let text = `🌅 <b>AcroGym Morning Digest</b>${dryRunMark}\n`;
  text    += `<i>Дата: ${formatDate(now)}</i>\n\n`;

  // Блок "Вчера"
  if (totalCount === 0) {
    text += `🌙 Вчера тихо — новых заявок не было.\n\n`;
  } else {
    const langLine = [
      byLang['RU'] && `🇷🇺 ${byLang['RU']}`,
      byLang['EN'] && `🇬🇧 ${byLang['EN']}`,
      byLang['AR'] && `🇶🇦 ${byLang['AR']}`,
    ].filter(Boolean).join(' / ');

    text += `📊 <b>Вчера (${yesterday.format('D MMM')})</b>\n`;
    text += `• Новых лидов: ${newCount}${langLine ? ` (${langLine})` : ''}\n`;
    if (existingCount) text += `• Existing T&C: ${existingCount}\n`;
    if (returningCount) text += `• Returning: ${returningCount}\n`;
    if (unknownCount)   text += `• Тип не определён: ${unknownCount}\n`;
    text += `• Всего заявок: ${totalCount}\n\n`;
  }

  // Блок "Реакция"
  if (newCount > 0) {
    if (stats.unanswered === 0) {
      text += `🎉 Все вчерашние лиды отработаны!\n\n`;
    } else {
      text += `📞 <b>Реакция на новых лидов</b>\n`;
      text += `• Ответили: ${stats.responded} из ${newCount} (${Math.round(stats.responded / newCount * 100)}%)\n`;
      text += `• Висят без ответа: ${stats.unanswered}\n\n`;
    }
  }

  // Самый давний неотвеченный
  if (oldestUnanswered) {
    const hoursWaiting = now.diff(dayjs(oldestUnanswered.notified_at), 'hour');
    text += `⏰ <b>Самый давний неотвеченный лид</b>\n`;
    text += `👤 ${oldestUnanswered.parent_name || '—'} (${LANG_FLAGS[oldestUnanswered.language] || ''} ${oldestUnanswered.language || '—'})\n`;
    text += `📱 ${formatPhone(oldestUnanswered.parent_phone)}\n`;
    text += `⌛ Ждёт ${hoursWaiting} ч.\n\n`;
  }

  // Топ-3 неотвеченных
  if (topUnanswered.length > 0) {
    text += `🔥 <b>Топ-${topUnanswered.length} неотвеченных лидов</b>\n`;
  }

  // copyCallbacks — для кнопок "Скопировать текст"
  const copyCallbacks = [];

  for (let i = 0; i < topUnanswered.length; i++) {
    const lead = topUnanswered[i];
    const hoursWaiting = now.diff(dayjs(lead.notified_at), 'hour');
    text += `${i + 1}. <i>${lead.parent_name || '—'}</i> — ${hoursWaiting}ч\n`;
    copyCallbacks.push({ index: i, leadId: lead.id, name: lead.parent_name });
  }

  if (topUnanswered.length > 0) text += '\n';

  // Тренд недели
  text += `📈 <b>Тренд недели</b>\n`;
  if (!hasTrendData) {
    text += `• 📊 Данных пока недостаточно\n\n`;
  } else {
    const avgStr = (last7Count / 7).toFixed(1);
    let trendLine = `• За последние 7 дней: ${last7Count} лидов (среднее ${avgStr}/день)\n`;
    if (prev7Count > 0) {
      const change = Math.round((last7Count - prev7Count) / prev7Count * 100);
      const arrow  = change >= 0 ? '↗️' : '↘️';
      trendLine += `• Тренд: ${arrow} ${change >= 0 ? '+' : ''}${change}% к предыдущей неделе\n`;
    }
    text += trendLine + '\n';
  }

  // Прогноз до открытия
  text += `🎯 <b>Прогноз до открытия (1 сентября 2026)</b>\n`;
  text += `• Дней до открытия: ${daysLeft}\n`;
  if (avgPerDay > 0) {
    text += `• При текущем темпе: ~${projected} лидов\n`;
    text += `• Нужно для 300 студентов (конверсия ${Math.round(TARGET_CONV * 100)}%): ~${neededLeads}\n`;
    text += `• Статус: ${forecastStatus}\n`;
  } else {
    text += `• 📊 Данных для прогноза пока недостаточно\n`;
  }

  return { text, copyCallbacks, topUnanswered };
}

module.exports = { buildDigest };
