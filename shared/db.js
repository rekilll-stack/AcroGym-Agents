'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../data/acrogym.db');

let _db = null;

function getDb() {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _initSchema(_db);
  _runMigrations(_db);
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
      client_type       TEXT DEFAULT 'unknown',
      raw_data          TEXT,
      status            TEXT DEFAULT 'new',
      notified_at       TEXT,
      reminder_sent_at  TEXT,
      responded_at      TEXT,
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

    CREATE TABLE IF NOT EXISTS client_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id         INTEGER REFERENCES leads(id),
      message_type    TEXT,
      text            TEXT,
      language        TEXT,
      channel         TEXT,
      delivery_status TEXT DEFAULT 'queued',
      agent_name      TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      sent_at         TEXT,
      confirmed_at    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_leads_status        ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_phone         ON leads(parent_phone);
    CREATE INDEX IF NOT EXISTS idx_client_msgs_lead_id ON client_messages(lead_id);
  `);
}

// Аддитивные миграции — идемпотентны
function _runMigrations(db) {
  const migrations = [
    // v1: добавляем client_type если его нет (для существующих БД)
    () => db.exec(`ALTER TABLE leads ADD COLUMN client_type TEXT DEFAULT 'unknown'`),
    // v2: добавляем responded_at
    () => db.exec(`ALTER TABLE leads ADD COLUMN responded_at TEXT`),
    // v3: индекс по client_type
    () => db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_client_type ON leads(client_type)`),
  ];

  for (const migrate of migrations) {
    try {
      migrate();
    } catch (err) {
      // "duplicate column name" и "already exists" — нормально, пропускаем
      if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
        throw err;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// CRUD функции
// ─────────────────────────────────────────────────────────────

function insertLead(lead) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO leads
      (sheet_row_number, timestamp, parent_name, parent_phone, parent_whatsapp,
       parent_email, qid, language, client_type, raw_data, status)
    VALUES
      (@sheet_row_number, @timestamp, @parent_name, @parent_phone, @parent_whatsapp,
       @parent_email, @qid, @language, @client_type, @raw_data, @status)
  `);
  return stmt.run(lead);
}

function getLeadByRow(sheetRowNumber) {
  const db = getDb();
  return db.prepare('SELECT * FROM leads WHERE sheet_row_number = ?').get(sheetRowNumber);
}

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

function getLeadsNeedingReminder(reminderHours) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM leads
    WHERE status IN ('notified', 'returning_notified')
      AND reminder_sent_at IS NULL
      AND notified_at IS NOT NULL
      AND notified_at <= datetime('now', ? || ' hours')
  `).all(`-${reminderHours}`);
}

// Статистика за конкретный день (для morning-digest)
// dateStr — 'YYYY-MM-DD' в UTC (конвертируем из Qatar time снаружи)
function getDailyStats(dateStr) {
  const db = getDb();
  const start = `${dateStr} 00:00:00`;
  const end   = `${dateStr} 23:59:59`;

  const byType = db.prepare(`
    SELECT client_type, COUNT(*) as cnt
    FROM leads
    WHERE created_at BETWEEN ? AND ?
    GROUP BY client_type
  `).all(start, end);

  const byLang = db.prepare(`
    SELECT language, COUNT(*) as cnt
    FROM leads
    WHERE created_at BETWEEN ? AND ?
      AND client_type = 'new'
    GROUP BY language
  `).all(start, end);

  const responded = db.prepare(`
    SELECT COUNT(*) as cnt FROM leads
    WHERE created_at BETWEEN ? AND ?
      AND client_type = 'new'
      AND status = 'responded'
  `).get(start, end);

  const unanswered = db.prepare(`
    SELECT COUNT(*) as cnt FROM leads
    WHERE created_at BETWEEN ? AND ?
      AND client_type = 'new'
      AND status = 'notified'
  `).get(start, end);

  return { byType, byLang, responded: responded.cnt, unanswered: unanswered.cnt };
}

// Топ-N неотвеченных лидов (для дайджеста)
function getTopUnanswered(limit = 3) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM leads
    WHERE status = 'notified'
      AND client_type = 'new'
    ORDER BY notified_at ASC
    LIMIT ?
  `).all(limit);
}

// Количество лидов за диапазон дат
function countLeadsInRange(startDateStr, endDateStr) {
  const db = getDb();
  return db.prepare(`
    SELECT COUNT(*) as cnt FROM leads
    WHERE created_at BETWEEN ? AND ?
  `).get(`${startDateStr} 00:00:00`, `${endDateStr} 23:59:59`).cnt;
}

module.exports = {
  getDb,
  insertLead,
  getLeadByRow,
  updateLeadStatus,
  getLeadsNeedingReminder,
  getDailyStats,
  getTopUnanswered,
  countLeadsInRange,
};
