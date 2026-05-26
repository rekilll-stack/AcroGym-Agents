'use strict';

const { createLogger } = require('./logger');
const logger = createLogger('column-mapper');

/**
 * Правила маппинга: более специфичные — первыми.
 * match(header) возвращает true если заголовок относится к полю.
 */
const MAPPING_RULES = [
  {
    field: 'timestamp',
    match: h => h.includes('timestamp') || h.includes('отметка времени'),
  },
  {
    field: 'client_type',
    match: h => h.includes('client_type') || h.includes('client type'),
  },
  {
    field: 'parent_whatsapp',
    match: h => h.includes('whatsapp') || h.includes('ватсап') || h.includes('واتساب'),
  },
  {
    field: 'parent_phone',
    match: h =>
      (h.includes('phone') || h.includes('mobile') || h.includes('телефон') || h.includes('هاتف')) &&
      !h.includes('whatsapp'),
  },
  {
    field: 'parent_email',
    match: h =>
      (h.includes('email') || h.includes('e-mail') || h.includes('почта') || h.includes('بريد')) &&
      !h.includes('child'),
  },
  {
    field: 'qid',
    match: h =>
      h.includes('qid') ||
      h.includes('national id') ||
      h.includes('id number') ||
      h.includes('qatar id') ||
      h.includes('удостоверение'),
  },
  {
    // parent name: содержит "parent"+"name" ИЛИ "your name" ИЛИ "имя"/"اسم" — но НЕ "child"
    field: 'parent_first_name',
    match: h =>
      !h.includes('child') &&
      !h.includes('ребён') &&
      !h.includes('طفل') &&
      ((h.includes('parent') && h.includes('first name')) ||
        (h.includes('guardian') && h.includes('first name')) ||
        h === 'your first name' ||
        h === 'имя'),
  },
  {
    field: 'parent_last_name',
    match: h =>
      !h.includes('child') &&
      ((h.includes('parent') && h.includes('last name')) ||
        (h.includes('guardian') && h.includes('last name'))),
  },
  {
    field: 'child_name',
    match: h =>
      (h.includes('child') || h.includes('ребён') || h.includes('طفل')) &&
      (h.includes('name') || h.includes('имя') || h.includes('اسم')),
  },
  {
    field: 'child_age',
    match: h =>
      (h.includes('child') || h.includes('ребён')) &&
      (h.includes('age') || h.includes('возраст') || h.includes('عمر') || h.includes('birth')),
  },
  {
    field: 'child_level',
    match: h =>
      (h.includes('child') || h.includes('ребён')) &&
      (h.includes('level') || h.includes('experience') || h.includes('уровень') || h.includes('опыт')),
  },
  {
    field: 'ready_date',
    match: h =>
      h.includes('when') ||
      h.includes('start') ||
      h.includes('когда') ||
      h.includes('متى'),
  },
  {
    field: 'source',
    match: h =>
      h.includes('where') ||
      h.includes('how did you hear') ||
      h.includes('откуда') ||
      h.includes('كيف'),
  },
];

/**
 * Принимает массив заголовков, возвращает { fieldName: columnIndex }.
 * Если поле не найдено — оно отсутствует в объекте.
 * Логирует WARN по непокрытым колонкам.
 *
 * @param {string[]} headers
 * @returns {Object.<string, number>}
 */
function mapColumns(headers) {
  const result = {};
  const coveredIndices = new Set();

  for (const { field, match } of MAPPING_RULES) {
    // Берём только первое совпадение (если поле ещё не найдено)
    if (field in result) continue;

    const idx = headers.findIndex(h => match(h.toLowerCase().trim()));
    if (idx !== -1 && !coveredIndices.has(idx)) {
      result[field] = idx;
      coveredIndices.add(idx);
    }
  }

  // Логируем непокрытые колонки
  const uncovered = headers
    .map((h, i) => ({ h, i }))
    .filter(({ i }) => !coveredIndices.has(i))
    .filter(({ h }) => {
      const l = h.toLowerCase().trim();
      // Игнорируем служебные
      return !l.includes('acceptance') &&
             !l.includes('signature') &&
             !l.includes('column ') &&
             !l.includes('photograph') &&
             !l.includes('permission') &&
             l.length > 0;
    });

  if (uncovered.length > 0) {
    // debug: не спамим в out.log при каждом старте — включается через LOG_LEVEL=debug
    logger.debug(
      { uncovered: uncovered.map(u => `[${u.i}] ${u.h}`) },
      `Unmapped columns: ${uncovered.length} (set LOG_LEVEL=debug to inspect)`
    );
  }

  logger.debug({ mapped: result }, 'Маппинг колонок построен');
  return result;
}

module.exports = { mapColumns };
