'use strict';

// Реестр разосланных карточек лидов: leadId → копии на всех админ-телефонах.
// Нужен для синхронизации кнопок «✅ responded / ↩️ undo» между устройствами:
// нажатие на одном телефоне обновляет карточку у всех.
// ponytail: JSON-файл вместо таблицы БД (без миграции); при утере файла
// синхронизация просто не сработает для старых карточек — не критично.

const fs = require('fs');
const path = require('path');

const REG_PATH = path.join(__dirname, '../data/lead-cards.json');
const MAX_LEADS = 300; // прунинг: храним копии для последних 300 лидов

function _load() {
  try { return JSON.parse(fs.readFileSync(REG_PATH, 'utf8')); } catch { return {}; }
}
function _save(reg) {
  const keys = Object.keys(reg);
  if (keys.length > MAX_LEADS) {
    keys.sort((a, b) => Number(a) - Number(b)).slice(0, keys.length - MAX_LEADS)
      .forEach(k => delete reg[k]);
  }
  try { fs.writeFileSync(REG_PATH, JSON.stringify(reg)); } catch { /* не критично */ }
}

/**
 * Записать разосланные копии карточки.
 * @param {number|string} leadId
 * @param {string} text — текст карточки (HTML), нужен для последующего edit
 * @param {Array<{chat:{id:number}, message_id:number}>} sentMessages — из sendToAdmin
 */
function recordCards(leadId, text, sentMessages = []) {
  if (!sentMessages.length) return;
  const reg = _load();
  const list = reg[String(leadId)] || [];
  for (const m of sentMessages) {
    if (m && m.chat && m.message_id) list.push({ chatId: m.chat.id, messageId: m.message_id, text });
  }
  reg[String(leadId)] = list.slice(-12); // максимум 12 копий на лид (карточка+напоминания × телефоны)
  _save(reg);
}

/** Все копии карточек лида. */
function listCards(leadId) {
  return _load()[String(leadId)] || [];
}

module.exports = { recordCards, listCards };
