'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../data/acrogym.db');

let _db = null;

function getDb() {
  if (_db) return _db;

  // Убеждаемся что папка data существует
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _initSchema(_db);
  return _db;
}

function _initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_row_number  INTEGER UNIQUE,
      timestamp         TEXT,
      parent_name       TEXT,
      parent_phone      TEXT,
      parent_whatsapp   TEXT,
      parent_email      TEXT,
      qid               TEXT,
      language          TEXT,
      raw_data          TEXT,
      status            TEXT DEFAULT 'new',
      notified_at       TEXT,
      reminder_sent_at  TEXT,
      created_at        TEXT DEFAULT (datetime('now')),
      updated_at        TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      agent      TEXT,
      level      TEXT,
      message    TEXT,
      context    TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_phone  ON leads(parent_phone);
  `);
}

// Вставляет новый лид. Возвращает объект с lastInsertRowid.
function insertLead(lead) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO leads
      (sheet_row_number, timestamp, parent_name, parent_phone, parent_whatsapp,
       parent_email, qid, language, raw_data, status)
    VALUES
      (@sheet_row_number, @timestamp, @parent_name, @parent_phone, @parent_whatsapp,
       @parent_email, @qid, @language, @raw_data, @status)
  `);
  return stmt.run(lead);
}

// Получить лид по номеру строки в Sheets
function getLeadByRow(sheetRowNumber) {
  const db = getDb();
  return db.prepare('SELECT * FROM leads WHERE sheet_row_number = ?').get(sheetRowNumber);
}

// Обновить статус лида и related поля
function updateLeadStatus(sheetRowNumber, updates) {
  const db = getDb();
  const fields = Object.keys(updates)
    .map(k => `${k} = @${k}`)
    .join(', ');
  const stmt = db.prepare(`
    UPDATE leads
    SET ${fields}, updated_at = datetime('now')
    WHERE sheet_row_number = @sheet_row_number
  `);
  return stmt.run({ ...updates, sheet_row_number: sheetRowNumber });
}

// Лиды, которым нужно напоминание:
// статус 'notified' + notified_at было > REMINDER_HOURS назад + reminder_sent_at IS NULL
function getLeadsNeedingReminder(reminderHours) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM leads
    WHERE status = 'notified'
      AND reminder_sent_at IS NULL
      AND notified_at IS NOT NULL
      AND notified_at <= datetime('now', ? || ' hours')
  `).all(`-${reminderHours}`);
}

module.exports = { getDb, insertLead, getLeadByRow, updateLeadStatus, getLeadsNeedingReminder };
