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
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_row_number    INTEGER UNIQUE,
      timestamp           TEXT,
      parent_name         TEXT,
      parent_phone        TEXT,
      parent_whatsapp     TEXT,
      parent_email        TEXT,
      qid                 TEXT,
      language            TEXT DEFAULT 'en',
      client_type         TEXT DEFAULT 'unknown',
      phone_normalized    TEXT,
      whatsapp_normalized TEXT,
      email_normalized    TEXT,
      ref_lead_id         INTEGER,
      raw_data            TEXT,
      status              TEXT DEFAULT 'new',
      notified_at         TEXT,
      reminder_sent_at    TEXT,
      responded_at        TEXT,
      created_at          TEXT DEFAULT (datetime('now')),
      updated_at          TEXT DEFAULT (datetime('now'))
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

// Idempotent migrations — safe to run on existing DBs
function _runMigrations(db) {
  const migrations = [
    () => db.exec(`ALTER TABLE leads ADD COLUMN client_type TEXT DEFAULT 'unknown'`),
    () => db.exec(`ALTER TABLE leads ADD COLUMN responded_at TEXT`),
    () => db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_client_type ON leads(client_type)`),
    () => db.exec(`ALTER TABLE leads ADD COLUMN phone_normalized TEXT`),
    () => db.exec(`ALTER TABLE leads ADD COLUMN whatsapp_normalized TEXT`),
    () => db.exec(`ALTER TABLE leads ADD COLUMN email_normalized TEXT`),
    () => db.exec(`ALTER TABLE leads ADD COLUMN ref_lead_id INTEGER`),
    () => db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_phone_norm     ON leads(phone_normalized)`),
    () => db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_whatsapp_norm  ON leads(whatsapp_normalized)`),
    () => db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_email_norm     ON leads(email_normalized)`),
    () => db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_ref            ON leads(ref_lead_id)`),
    // v12-v14: greeting storage + lead source tracking
    () => db.exec(`ALTER TABLE leads ADD COLUMN generated_greeting TEXT`),
    () => db.exec(`ALTER TABLE leads ADD COLUMN source TEXT`),
    () => db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source)`),
  ];

  for (const migrate of migrations) {
    try {
      migrate();
    } catch (err) {
      if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
        throw err;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────

function insertLead(lead) {
  const db = getDb();
  return db.prepare(`
    INSERT OR IGNORE INTO leads
      (sheet_row_number, timestamp, parent_name, parent_phone, parent_whatsapp,
       parent_email, qid, language, client_type,
       phone_normalized, whatsapp_normalized, email_normalized,
       ref_lead_id, raw_data, status)
    VALUES
      (@sheet_row_number, @timestamp, @parent_name, @parent_phone, @parent_whatsapp,
       @parent_email, @qid, @language, @client_type,
       @phone_normalized, @whatsapp_normalized, @email_normalized,
       @ref_lead_id, @raw_data, @status)
  `).run(lead);
}

function getLeadByRow(sheetRowNumber) {
  return getDb().prepare('SELECT * FROM leads WHERE sheet_row_number = ?').get(sheetRowNumber);
}

function updateLeadStatus(sheetRowNumber, updates) {
  const db = getDb();
  const fields = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  return db.prepare(`
    UPDATE leads SET ${fields}, updated_at = datetime('now')
    WHERE sheet_row_number = @sheet_row_number
  `).run({ ...updates, sheet_row_number: sheetRowNumber });
}

function getLeadsNeedingReminder(reminderHours) {
  return getDb().prepare(`
    SELECT * FROM leads
    WHERE status IN ('notified', 'returning_notified')
      AND reminder_sent_at IS NULL
      AND notified_at IS NOT NULL
      AND notified_at <= datetime('now', ? || ' hours')
  `).all(`-${reminderHours}`);
}

/**
 * Finds an existing lead matching phone, whatsapp, email, or QID.
 * Returns the most recent match, or null.
 *
 * @param {{ phoneNorm, whatsappNorm, emailNorm, qid }} normalized
 * @returns {object|null}
 */
function findExistingLead({ phoneNorm, whatsappNorm, emailNorm, qid }) {
  return getDb().prepare(`
    SELECT * FROM leads
    WHERE
      (? IS NOT NULL AND phone_normalized    = ?)
      OR (? IS NOT NULL AND whatsapp_normalized = ?)
      OR (? IS NOT NULL AND email_normalized    = ?)
      OR (? IS NOT NULL AND ? != '' AND qid     = ?)
    ORDER BY created_at DESC
    LIMIT 1
  `).get(
    phoneNorm,    phoneNorm,
    whatsappNorm, whatsappNorm,
    emailNorm,    emailNorm,
    qid,          qid, qid
  ) || null;
}

// ─────────────────────────────────────────────────────────────
// Single-lead helpers
// ─────────────────────────────────────────────────────────────

function getLeadById(id) {
  return getDb().prepare('SELECT * FROM leads WHERE id = ?').get(id) || null;
}

/** Saves the Claude-generated greeting text for a lead. */
function updateLeadGreeting(leadId, greetingText) {
  return getDb().prepare(
    `UPDATE leads SET generated_greeting = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(greetingText, leadId);
}

// ─────────────────────────────────────────────────────────────
// Pending leads helpers
// ─────────────────────────────────────────────────────────────

function getAllPending(limit = 50, offset = 0) {
  return getDb().prepare(`
    SELECT * FROM leads
    WHERE status = 'notified' AND client_type = 'new'
    ORDER BY notified_at ASC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function countPending() {
  return getDb().prepare(`
    SELECT COUNT(*) as cnt FROM leads
    WHERE status = 'notified' AND client_type = 'new'
  `).get().cnt;
}

/**
 * Returns leads that have been in 'notified' status for more than `hours` hours.
 */
function getLongPending(hours = 24) {
  return getDb().prepare(`
    SELECT * FROM leads
    WHERE status = 'notified'
      AND client_type = 'new'
      AND notified_at <= datetime('now', '-' || ? || ' hours')
    ORDER BY notified_at ASC
  `).all(hours);
}

/**
 * Leads that were responded to on a given date (YYYY-MM-DD, Qatar time).
 */
function getYesterdayResponded(dateStr) {
  return getDb().prepare(`
    SELECT * FROM leads
    WHERE status = 'responded'
      AND DATE(datetime(responded_at, '+3 hours')) = ?
    ORDER BY responded_at ASC
  `).all(dateStr);
}

// ─────────────────────────────────────────────────────────────
// Analytics / chart data helpers
// ─────────────────────────────────────────────────────────────

/** Total new leads accumulated (for goal tracking). Excludes legacy/test data. */
function countTotalLeads() {
  return getDb().prepare(`
    SELECT COUNT(*) as cnt FROM leads WHERE client_type = 'new'
  `).get().cnt;
}

/**
 * Per-day lead counts for the last N days (Qatar local time).
 * Returns [{day: 'YYYY-MM-DD', cnt: N}, ...]
 */
function getLeadsByDay(days = 7) {
  return getDb().prepare(`
    SELECT DATE(datetime(created_at, '+3 hours')) as day, COUNT(*) as cnt
    FROM leads
    WHERE created_at >= datetime('now', '-' || ? || ' days')
      AND client_type != 'legacy'
    GROUP BY DATE(datetime(created_at, '+3 hours'))
    ORDER BY day ASC
  `).all(days);
}

/**
 * Per-day-of-week counts for the last N days (Qatar time, 0=Sun).
 * Returns [{dow: '0'..'6', cnt: N}, ...]
 */
function getLeadsByDayOfWeek(days = 28) {
  return getDb().prepare(`
    SELECT strftime('%w', datetime(created_at, '+3 hours')) as dow, COUNT(*) as cnt
    FROM leads
    WHERE created_at >= datetime('now', '-' || ? || ' days')
      AND client_type != 'legacy'
    GROUP BY strftime('%w', datetime(created_at, '+3 hours'))
    ORDER BY dow ASC
  `).all(days);
}

/**
 * Per-hour counts for the last N days (Qatar time).
 * Returns [{hour: '00'..'23', cnt: N}, ...]
 */
function getLeadsByHour(days = 28) {
  return getDb().prepare(`
    SELECT strftime('%H', datetime(created_at, '+3 hours')) as hour, COUNT(*) as cnt
    FROM leads
    WHERE created_at >= datetime('now', '-' || ? || ' days')
      AND client_type != 'legacy'
    GROUP BY strftime('%H', datetime(created_at, '+3 hours'))
    ORDER BY hour ASC
  `).all(days);
}

/**
 * Per-day lead counts for a specific date range.
 * Returns [{day: 'YYYY-MM-DD', cnt: N}, ...]
 */
function getLeadsByDayRange(startDate, endDate) {
  return getDb().prepare(`
    SELECT DATE(datetime(created_at, '+3 hours')) as day, COUNT(*) as cnt
    FROM leads
    WHERE DATE(datetime(created_at, '+3 hours')) BETWEEN ? AND ?
      AND client_type != 'legacy'
    GROUP BY DATE(datetime(created_at, '+3 hours'))
    ORDER BY day ASC
  `).all(startDate, endDate);
}

// ─────────────────────────────────────────────────────────────
// Morning-digest helpers
// ─────────────────────────────────────────────────────────────

function getDailyStats(dateStr) {
  const db = getDb();
  const start = `${dateStr} 00:00:00`;
  const end   = `${dateStr} 23:59:59`;

  const byType = db.prepare(`
    SELECT client_type, COUNT(*) as cnt FROM leads
    WHERE created_at BETWEEN ? AND ? AND client_type != 'legacy' GROUP BY client_type
  `).all(start, end);

  const byLang = db.prepare(`
    SELECT language, COUNT(*) as cnt FROM leads
    WHERE created_at BETWEEN ? AND ? AND client_type = 'new' GROUP BY language
  `).all(start, end);

  const responded = db.prepare(`
    SELECT COUNT(*) as cnt FROM leads
    WHERE created_at BETWEEN ? AND ? AND client_type = 'new' AND status = 'responded'
  `).get(start, end);

  const unanswered = db.prepare(`
    SELECT COUNT(*) as cnt FROM leads
    WHERE created_at BETWEEN ? AND ? AND client_type = 'new' AND status = 'notified'
  `).get(start, end);

  return { byType, byLang, responded: responded.cnt, unanswered: unanswered.cnt };
}

function getTopUnanswered(limit = 3) {
  return getDb().prepare(`
    SELECT * FROM leads
    WHERE status = 'notified' AND client_type = 'new'
    ORDER BY notified_at ASC LIMIT ?
  `).all(limit);
}

function countLeadsInRange(startDateStr, endDateStr) {
  return getDb().prepare(`
    SELECT COUNT(*) as cnt FROM leads
    WHERE created_at BETWEEN ? AND ?
      AND client_type != 'legacy'
  `).get(`${startDateStr} 00:00:00`, `${endDateStr} 23:59:59`).cnt;
}

module.exports = {
  getDb,
  insertLead,
  getLeadByRow,
  getLeadById,
  getYesterdayResponded,
  updateLeadStatus,
  updateLeadGreeting,
  getLeadsNeedingReminder,
  findExistingLead,
  getAllPending,
  countPending,
  getLongPending,
  countTotalLeads,
  getLeadsByDay,
  getLeadsByDayOfWeek,
  getLeadsByHour,
  getLeadsByDayRange,
  getDailyStats,
  getTopUnanswered,
  countLeadsInRange,
};
