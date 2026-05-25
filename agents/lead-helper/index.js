'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const cron = require('node-cron');
const { createLogger }       = require('../../shared/logger');
const { fetchAllResponses }  = require('../../shared/sheets');
const { detectLanguage }     = require('../../shared/language');
const { mapColumns }         = require('../../shared/column-mapper');
const { parseClientType }    = require('../../shared/client-type');
const { generateText }       = require('../../shared/claude');
const { sendToAdmin }        = require('../../shared/notify');
const { sendToClient }       = require('../../shared/client-messaging'); // абстракция канала клиента
const {
  editMessage,
  registerCallback,
  startCallbackPolling,
} = require('../../shared/telegram');
const {
  insertLead,
  getLeadByRow,
  updateLeadStatus,
  getLeadsNeedingReminder,
} = require('../../shared/db');
const { buildGreetingPrompt } = require('./prompts');

const logger = createLogger('lead-helper');

const POLL_INTERVAL  = parseInt(process.env.POLL_INTERVAL_SECONDS || '60', 10) * 1000;
const REMINDER_HOURS = parseInt(process.env.REMINDER_HOURS || '2', 10);

// ─────────────────────────────────────────────────────────────
// Парсинг строки через mapColumns
// ─────────────────────────────────────────────────────────────

function parseRowToLead(headers, values, colMap) {
  const get = (field) => {
    const idx = colMap[field];
    return idx !== undefined ? (values[idx] || '').trim() : '';
  };

  const firstName  = get('parent_first_name');
  const lastName   = get('parent_last_name');
  const parentName = [firstName, lastName].filter(Boolean).join(' ').trim();

  // Первый непустой child first name (таблица имеет несколько блоков)
  const childNameIdx = headers.findIndex((h, i) => {
    const lower = h.toLowerCase().trim();
    return lower.includes('child') && lower.includes('first name') && (values[i] || '').trim();
  });
  const childName = childNameIdx !== -1 ? (values[childNameIdx] || '').trim() : '';

  return {
    parent_name:     parentName,
    parent_phone:    get('parent_phone'),
    parent_whatsapp: get('parent_whatsapp'),
    parent_email:    get('parent_email'),
    qid:             get('qid'),
    timestamp:       get('timestamp'),
    client_type:     parseClientType(get('client_type')),
    child_name:      childName,
    ready_date:      get('ready_date'),
  };
}

// ─────────────────────────────────────────────────────────────
// Форматирование КАРТОЧКИ ЛИДА (только для команды)
// NB: текст для клиента идёт отдельно через sendToClient()
// ─────────────────────────────────────────────────────────────

const LANG_FLAGS = { RU: '🇷🇺 RU', EN: '🇬🇧 EN', AR: '🇶🇦 AR' };

function formatLeadCard(lead, rowNumber, extra = {}) {
  const { isReminder, isReturning, isUnknownType } = extra;

  let header;
  if (isReminder) {
    header = `⏰ <b>Напоминание: заявка #${rowNumber} ждёт ответа уже ${REMINDER_HOURS} ч.</b>`;
  } else if (isReturning) {
    header = `↩️ <b>Возвращающийся клиент — заявка #${rowNumber}</b>`;
  } else if (isUnknownType) {
    header = `⚠️ <b>Заявка #${rowNumber} — тип клиента не определён, проверь форму</b>`;
  } else {
    header = `📩 <b>Новая заявка #${rowNumber}</b>`;
  }

  const ts = lead.timestamp
    ? new Date(lead.timestamp).toLocaleString('ru-RU', {
        timeZone: process.env.TIMEZONE || 'Asia/Qatar',
      })
    : '—';

  let footer = '';
  if (isReturning) {
    footer = '\n\n💬 Клиент уже занимался у нас. Свяжись лично, обсуди условия возврата.';
  } else if (isUnknownType) {
    footer = '\n\n⚠️ Тип клиента не определён автоматически — проверь форму.';
  }
  // Для new/reminder: текст для клиента идёт отдельным сообщением через sendToClient()

  return `${header}

👤 ${lead.parent_name || '—'}
📱 Телефон: ${lead.parent_phone || '—'}
💬 WhatsApp: ${lead.parent_whatsapp || lead.parent_phone || '—'}
✉️ Email: ${lead.parent_email || '—'}
🌍 Язык: ${LANG_FLAGS[lead.language] || lead.language || '—'}
⏰ Получена: ${ts}${footer}`;
}

function respondedKeyboard(rowNumber, label = '✅ Я ответил') {
  return {
    inline_keyboard: [[
      { text: label, callback_data: `responded:${rowNumber}` },
    ]],
  };
}

// ─────────────────────────────────────────────────────────────
// Обработка нового лида
// ─────────────────────────────────────────────────────────────

async function processNewLead(rowNumber, headers, values, colMap) {
  const parsed   = parseRowToLead(headers, values, colMap);
  const language = detectLanguage(parsed.parent_name);

  const leadData = {
    sheet_row_number: rowNumber,
    ...parsed,
    language,
    raw_data: JSON.stringify({ headers, values }),
    status: 'new',
  };

  const inserted = insertLead(leadData);
  if (inserted.changes === 0) return; // идемпотентность

  const leadId = inserted.lastInsertRowid;

  logger.info(
    { rowNumber, leadId, client_type: parsed.client_type, language, name: parsed.parent_name },
    'Новый лид сохранён'
  );

  const ct = parsed.client_type;

  // ── EXISTING: тихо фиксируем, morning-digest подхватит ──
  if (ct === 'existing') {
    updateLeadStatus(rowNumber, { status: 'existing_signed' });
    logger.info({ rowNumber, name: parsed.parent_name }, 'Existing member signed T&C');
    return;
  }

  // ── NEW: карточка лида + отдельный draft-текст для клиента ──
  if (ct === 'new') {
    // 1. Карточка для команды
    const card = formatLeadCard({ ...parsed, language }, rowNumber);
    await sendToAdmin(card, { reply_markup: respondedKeyboard(rowNumber) });

    // 2. Генерация приветствия + отправка через sendToClient()
    try {
      const prompt = buildGreetingPrompt({ parentName: parsed.parent_name, language });
      const greetingText = await generateText(prompt);

      await sendToClient({
        lead: { ...parsed, language },
        messageText: greetingText,
        messageType: 'greeting',
        metadata: { agentName: 'lead-helper', leadId },
      });
    } catch (err) {
      logger.warn({ err }, 'Не удалось сгенерировать/отправить приветствие для клиента');
      // Карточка лида уже отправлена — команда знает о лиде, текст придётся написать вручную
    }

    updateLeadStatus(rowNumber, {
      status: 'notified',
      notified_at: new Date().toISOString(),
    });

    logger.info({ rowNumber, leadId }, 'Новый лид — уведомления отправлены');
    return;
  }

  // ── RETURNING: карточка с пометкой, без Claude ──
  if (ct === 'returning') {
    const card = formatLeadCard({ ...parsed, language }, rowNumber, { isReturning: true });
    await sendToAdmin(card, { reply_markup: respondedKeyboard(rowNumber, '✅ Связался') });

    updateLeadStatus(rowNumber, {
      status: 'returning_notified',
      notified_at: new Date().toISOString(),
    });

    logger.info({ rowNumber }, 'Returning client — уведомление отправлено');
    return;
  }

  // ── UNKNOWN: предупреждение ──
  const card = formatLeadCard({ ...parsed, language }, rowNumber, { isUnknownType: true });
  await sendToAdmin(card, { reply_markup: respondedKeyboard(rowNumber) });

  updateLeadStatus(rowNumber, {
    status: 'notified',
    notified_at: new Date().toISOString(),
  });

  logger.warn({ rowNumber, rawType: values[colMap.client_type] }, 'unknown client_type');
}

// ─────────────────────────────────────────────────────────────
// Опрос Google Sheets
// ─────────────────────────────────────────────────────────────

let _colMap = null;

async function pollSheets() {
  logger.debug('Опрос Google Sheets...');
  let rows;

  try {
    rows = await fetchAllResponses();
  } catch (err) {
    logger.error({ err }, 'Ошибка чтения Google Sheets');
    return;
  }

  if (!rows || rows.length === 0) return;

  if (!_colMap) {
    _colMap = mapColumns(rows[0].headers);
    logger.info({ colMap: _colMap }, 'Маппинг колонок инициализирован');
  }

  for (const { rowNumber, headers, values } of rows) {
    if (getLeadByRow(rowNumber)) continue;

    try {
      await processNewLead(rowNumber, headers, values, _colMap);
    } catch (err) {
      logger.error({ err, rowNumber }, 'Ошибка обработки лида');
      await sendToAdmin(
        `🚨 Lead-helper: ошибка при обработке заявки #${rowNumber}\n<code>${err.message}</code>`
      ).catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Напоминания (каждые 10 минут)
// ─────────────────────────────────────────────────────────────

async function checkReminders() {
  logger.debug('Проверка напоминаний...');

  let leads;
  try {
    leads = getLeadsNeedingReminder(REMINDER_HOURS);
  } catch (err) {
    logger.error({ err }, 'Ошибка чтения напоминаний');
    return;
  }

  for (const lead of leads) {
    try {
      const card = formatLeadCard(lead, lead.sheet_row_number, { isReminder: true });
      await sendToAdmin(card, { reply_markup: respondedKeyboard(lead.sheet_row_number) });

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
// Callbacks
// ─────────────────────────────────────────────────────────────

function setupCallbacks() {
  // «✅ Я ответил» / «✅ Связался»
  registerCallback('responded', async (query, bot) => {
    const rowNumber = parseInt((query.data || '').split(':')[1], 10);
    if (isNaN(rowNumber)) return;

    try {
      updateLeadStatus(rowNumber, {
        status: 'responded',
        responded_at: new Date().toISOString(),
      });

      const time = new Date().toLocaleTimeString('ru-RU', {
        timeZone: process.env.TIMEZONE || 'Asia/Qatar',
        hour: '2-digit', minute: '2-digit',
      });

      await editMessage(
        'admin',
        query.message.chat.id,
        query.message.message_id,
        query.message.text + `\n\n<b>✅ Отвечено в ${time}</b>`,
        { reply_markup: { inline_keyboard: [] } }
      );

      await bot.answerCallbackQuery(query.id, { text: '✅ Зафиксировано' });
      logger.info({ rowNumber }, 'Лид → responded');
    } catch (err) {
      logger.error({ err, rowNumber }, 'Ошибка callback responded');
    }
  });

  // copy_text и client_sent регистрирует client-messaging.js при загрузке модуля
}

// ─────────────────────────────────────────────────────────────
// Запуск
// ─────────────────────────────────────────────────────────────

async function start() {
  logger.info({ pollInterval: POLL_INTERVAL / 1000 + 's', reminderHours: REMINDER_HOURS }, 'Lead-helper запускается');

  setupCallbacks();
  startCallbackPolling(); // единый polling для всех callbacks

  await pollSheets();

  setInterval(async () => {
    await pollSheets().catch(err => logger.error({ err }, 'pollSheets unhandled'));
  }, POLL_INTERVAL);

  cron.schedule('*/10 * * * *', async () => {
    await checkReminders().catch(err => logger.error({ err }, 'checkReminders unhandled'));
  });

  logger.info('Lead-helper запущен ✅');
}

// ─────────────────────────────────────────────────────────────
// Process guards
// ─────────────────────────────────────────────────────────────

process.on('SIGTERM', () => { logger.info('SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { logger.info('SIGINT');  process.exit(0); });

process.on('uncaughtException', async (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  await sendToAdmin(`🚨 Lead-helper упал: <code>${err.message}</code>`).catch(() => {});
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  logger.error({ reason }, 'Unhandled rejection');
  await sendToAdmin(`🚨 Lead-helper rejection: <code>${reason}</code>`).catch(() => {});
});

start().catch(async (err) => {
  logger.fatal({ err }, 'Ошибка запуска');
  await sendToAdmin(`🚨 Lead-helper не запустился: <code>${err.message}</code>`).catch(() => {});
  process.exit(1);
});
