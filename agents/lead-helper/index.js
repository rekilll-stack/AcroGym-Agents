'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const cron        = require('node-cron');
const { createLogger }         = require('../../shared/logger');
const { fetchAllResponses }    = require('../../shared/sheets');
const { detectLanguage }       = require('../../shared/language');
const { generateText }         = require('../../shared/claude');
const { sendToOwner }          = require('../../shared/notify');
const { editMessage, onCallbackQuery } = require('../../shared/telegram');
const {
  insertLead,
  getLeadByRow,
  updateLeadStatus,
  getLeadsNeedingReminder,
} = require('../../shared/db');
const { buildGreetingPrompt }  = require('./prompts');

const logger = createLogger('lead-helper');

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_SECONDS || '60', 10) * 1000;
const REMINDER_HOURS = parseInt(process.env.REMINDER_HOURS || '2', 10);

// ─────────────────────────────────────────────────────────────
// Гибкий маппинг колонок по подстрокам в заголовке
// ─────────────────────────────────────────────────────────────
const COLUMN_MAP = [
  { field: 'timestamp',       keywords: ['timestamp', 'time', 'date'] },
  { field: 'parent_name',     keywords: ['name', 'имя', 'اسم'] },
  { field: 'parent_phone',    keywords: ['phone', 'mobile', 'телефон', 'هاتف'] },
  { field: 'parent_whatsapp', keywords: ['whatsapp', 'вотсап', 'واتساب'] },
  { field: 'parent_email',    keywords: ['email', 'e-mail', 'почта', 'بريد'] },
  { field: 'qid',             keywords: ['qid', 'national', 'id number', 'qatar id'] },
];

/**
 * Парсит строку таблицы в объект лида на основе гибкого маппинга заголовков.
 */
function parseRowToLead(headers, values) {
  const lead = {};

  for (const { field, keywords } of COLUMN_MAP) {
    const colIdx = headers.findIndex(h => {
      const lower = (h || '').toLowerCase();
      return keywords.some(kw => lower.includes(kw));
    });
    lead[field] = colIdx !== -1 ? (values[colIdx] || '').trim() : '';
  }

  return lead;
}

// ─────────────────────────────────────────────────────────────
// Форматирование карточки лида для Telegram
// ─────────────────────────────────────────────────────────────
const LANG_FLAGS = { RU: '🇷🇺 RU', EN: '🇬🇧 EN', AR: '🇶🇦 AR' };

function formatLeadCard(lead, rowNumber, greetingText, isReminder = false) {
  const prefix = isReminder
    ? `⏰ <b>Напоминание: лид #${rowNumber} ждёт ответа уже ${REMINDER_HOURS} ч.</b>`
    : `📩 <b>Новая заявка #${rowNumber}</b>`;

  const ts = lead.timestamp
    ? new Date(lead.timestamp).toLocaleString('ru-RU', { timeZone: process.env.TIMEZONE || 'Asia/Qatar' })
    : '—';

  const greeting = greetingText
    ? `\n\n✍️ <b>Готовый текст для WhatsApp:</b>\n${greetingText}`
    : '\n\n⚠️ Текст не сгенерирован, напиши вручную.';

  return `${prefix}

👤 Имя: ${lead.parent_name || '—'}
📱 Телефон: ${lead.parent_phone || '—'}
💬 WhatsApp: ${lead.parent_whatsapp || lead.parent_phone || '—'}
✉️ Email: ${lead.parent_email || '—'}
🌍 Язык: ${LANG_FLAGS[lead.language] || lead.language}
⏰ Получена: ${ts}${greeting}`;
}

// ─────────────────────────────────────────────────────────────
// Inline-кнопка «Я ответил»
// ─────────────────────────────────────────────────────────────
function respondedKeyboard(rowNumber) {
  return {
    inline_keyboard: [[
      { text: '✅ Я ответил', callback_data: `responded:${rowNumber}` },
    ]],
  };
}

// ─────────────────────────────────────────────────────────────
// Обработка нового лида
// ─────────────────────────────────────────────────────────────
async function processNewLead(rowNumber, headers, values) {
  const parsedLead = parseRowToLead(headers, values);
  const language   = detectLanguage(parsedLead.parent_name);

  const leadData = {
    sheet_row_number: rowNumber,
    ...parsedLead,
    language,
    raw_data: JSON.stringify({ headers, values }),
    status: 'new',
  };

  // Идемпотентно — INSERT OR IGNORE
  const inserted = insertLead(leadData);
  if (inserted.changes === 0) {
    // Уже был в БД (не должно случиться, но на всякий случай)
    return;
  }

  logger.info({ rowNumber, language, name: parsedLead.parent_name }, 'Новый лид сохранён');

  // Генерируем приветствие через Claude
  let greetingText = null;
  try {
    const prompt = buildGreetingPrompt({ parentName: parsedLead.parent_name, language });
    greetingText = await generateText(prompt);
  } catch (err) {
    logger.warn({ err }, 'Claude не ответил, отправим без приветствия');
  }

  // Формируем карточку и шлём владельцу
  const card = formatLeadCard({ ...parsedLead, language }, rowNumber, greetingText);
  const msg = await sendToOwner(card, {
    reply_markup: respondedKeyboard(rowNumber),
  });

  // Обновляем статус в БД
  updateLeadStatus(rowNumber, {
    status: 'notified',
    notified_at: new Date().toISOString(),
  });

  logger.info({ rowNumber, msgId: msg?.message_id }, 'Владелец уведомлён о новом лиде');
}

// ─────────────────────────────────────────────────────────────
// Основной цикл — опрос Google Sheets
// ─────────────────────────────────────────────────────────────
async function pollSheets() {
  logger.debug('Опрос Google Sheets...');
  let rows;

  try {
    rows = await fetchAllResponses();
  } catch (err) {
    logger.error({ err }, 'Ошибка чтения Google Sheets');
    return; // не падаем, попробуем в следующем цикле
  }

  if (!rows || rows.length === 0) {
    logger.debug('Новых строк нет');
    return;
  }

  for (const { rowNumber, headers, values } of rows) {
    const existing = getLeadByRow(rowNumber);
    if (existing) continue; // уже обработан

    try {
      await processNewLead(rowNumber, headers, values);
    } catch (err) {
      logger.error({ err, rowNumber }, 'Ошибка обработки лида');
      await sendToOwner(`🚨 Lead-helper: ошибка при обработке заявки #${rowNumber}\n<code>${err.message}</code>`).catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Проверка и отправка напоминаний
// ─────────────────────────────────────────────────────────────
async function checkReminders() {
  logger.debug('Проверка напоминаний...');

  let leads;
  try {
    leads = getLeadsNeedingReminder(REMINDER_HOURS);
  } catch (err) {
    logger.error({ err }, 'Ошибка чтения лидов для напоминаний');
    return;
  }

  for (const lead of leads) {
    try {
      const card = formatLeadCard(lead, lead.sheet_row_number, null, true);
      await sendToOwner(card, { reply_markup: respondedKeyboard(lead.sheet_row_number) });

      updateLeadStatus(lead.sheet_row_number, {
        reminder_sent_at: new Date().toISOString(),
      });

      logger.info({ rowNumber: lead.sheet_row_number }, 'Напоминание отправлено');
    } catch (err) {
      logger.error({ err, leadId: lead.id }, 'Ошибка отправки напоминания');
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Обработчик inline-кнопки «Я ответил»
// ─────────────────────────────────────────────────────────────
function setupCallbackHandler() {
  const pollingBot = onCallbackQuery(async (query) => {
    const data = query.data || '';
    if (!data.startsWith('responded:')) return;

    const rowNumber = parseInt(data.split(':')[1], 10);
    if (isNaN(rowNumber)) return;

    try {
      updateLeadStatus(rowNumber, { status: 'responded' });
      logger.info({ rowNumber }, 'Статус лида → responded');

      // Редактируем исходное сообщение
      await editMessage(
        query.message.chat.id,
        query.message.message_id,
        query.message.text + '\n\n<b>✅ Отвечено</b>',
        { reply_markup: { inline_keyboard: [] } }
      );

      // Подтверждаем callback
      const bot = pollingBot;
      if (bot) await bot.answerCallbackQuery(query.id, { text: 'Статус обновлён ✅' });

    } catch (err) {
      logger.error({ err, rowNumber }, 'Ошибка обработки callback');
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Запуск агента
// ─────────────────────────────────────────────────────────────
async function start() {
  logger.info({ pollInterval: POLL_INTERVAL / 1000 + 's', reminderHours: REMINDER_HOURS }, 'Lead-helper запускается');

  // Обработчик inline-кнопок
  setupCallbackHandler();

  // Первый опрос сразу при старте
  await pollSheets();

  // Периодический опрос (каждые POLL_INTERVAL_SECONDS секунд)
  setInterval(async () => {
    await pollSheets().catch(err => logger.error({ err }, 'pollSheets unhandled error'));
  }, POLL_INTERVAL);

  // Напоминания каждые 10 минут
  cron.schedule('*/10 * * * *', async () => {
    await checkReminders().catch(err => logger.error({ err }, 'checkReminders unhandled error'));
  });

  logger.info('Lead-helper успешно запущен');
}

// ─────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  logger.info('SIGTERM получен, завершаем...');
  process.exit(0);
});
process.on('SIGINT', () => {
  logger.info('SIGINT получен, завершаем...');
  process.exit(0);
});
process.on('uncaughtException', async (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  await sendToOwner(`🚨 Lead-helper упал: <code>${err.message}</code>`).catch(() => {});
  process.exit(1);
});
process.on('unhandledRejection', async (reason) => {
  logger.error({ reason }, 'Unhandled rejection');
  await sendToOwner(`🚨 Lead-helper: unhandled rejection: <code>${reason}</code>`).catch(() => {});
});

start().catch(async (err) => {
  logger.fatal({ err }, 'Ошибка запуска lead-helper');
  await sendToOwner(`🚨 Lead-helper не запустился: <code>${err.message}</code>`).catch(() => {});
  process.exit(1);
});
