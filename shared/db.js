'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Defaults to the production DB; ACROGYM_DB_PATH lets tests target a temp file.
const DB_PATH = process.env.ACROGYM_DB_PATH || path.join(__dirname, '../data/acrogym.db');

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
    // v15: owner language preferences
    () => db.exec(`CREATE TABLE IF NOT EXISTS user_preferences (
      chat_id            INTEGER PRIMARY KEY,
      preferred_language TEXT    DEFAULT NULL,
      updated_at         TEXT    DEFAULT (datetime('now'))
    )`),
    // v16: multi-step export state
    () => db.exec(`CREATE TABLE IF NOT EXISTS user_state (
      chat_id        INTEGER PRIMARY KEY,
      current_action TEXT,
      current_step   TEXT,
      params_json    TEXT,
      updated_at     TEXT DEFAULT (datetime('now'))
    )`),
    () => db.exec(`CREATE INDEX IF NOT EXISTS idx_user_state_updated ON user_state(updated_at)`),
    // v17: watchdog heartbeats + anti-spam alert state
    () => db.exec(`CREATE TABLE IF NOT EXISTS heartbeats (
      agent_name TEXT PRIMARY KEY,
      last_ok_at INTEGER,
      detail     TEXT
    )`),
    () => db.exec(`CREATE TABLE IF NOT EXISTS watchdog_state (
      agent_name TEXT PRIMARY KEY,
      alert_state TEXT,
      alerted_at  INTEGER
    )`),
    // v18: Agent 3 nurture — raw child DOBs captured at parse time (additive,
    // populated like `source`; null when the form had no/garbled dates).
    () => db.exec(`ALTER TABLE leads ADD COLUMN children_dob TEXT`),
    // v19: nurture enrollment — one row per lead in the pre-launch warm-up.
    //   audience       = effective tone bucket (override ?? auto): cold|warm|enrolled
    //   audience_auto  = derived from client_type
    //   audience_override = manual correction (heuristic is fallible) — null until set
    //   age_segment    = marketing tone segment from youngest child: 3-5|6-9|10-14|unknown
    //   children_json  = ALL children [{dob,age,segment}] — nothing dropped
    //   status         = enrollment lifecycle (active|paused), NOT per-message delivery
    () => db.exec(`CREATE TABLE IF NOT EXISTS nurture_enrollments (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id           INTEGER UNIQUE REFERENCES leads(id),
      audience          TEXT,
      audience_auto     TEXT,
      audience_override TEXT,
      age_segment       TEXT,
      children_count    INTEGER,
      children_json     TEXT,
      status            TEXT DEFAULT 'active',
      created_at        TEXT DEFAULT (datetime('now')),
      updated_at        TEXT DEFAULT (datetime('now'))
    )`),
    () => db.exec(`CREATE INDEX IF NOT EXISTS idx_nurture_status   ON nurture_enrollments(status)`),
    () => db.exec(`CREATE INDEX IF NOT EXISTS idx_nurture_audience ON nurture_enrollments(audience)`),
    // v20: Part A lead ingestion — stable lead identity written by n8n into the
    // canonical sheet. NULL for legacy/Google-Form leads. Partial unique index:
    // uid leads are idempotent, NULLs never collide (SQLite treats them as
    // distinct), so the legacy rows are untouched.
    () => db.exec(`ALTER TABLE leads ADD COLUMN lead_uid TEXT`),
    () => db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_uid
                   ON leads(lead_uid) WHERE lead_uid IS NOT NULL`),

    // v21: registrations — projection of the big enrollment form (separate from
    // the leads pipeline). Filled by a dedicated poller (scripts/poll-registrations).
    // Booleans are 0/1. raw_row_hash (UNIQUE) is the upsert key — re-reading the
    // sheet never duplicates; an edited submission upserts. updated_at is bumped
    // explicitly on UPDATE (SQLite's DEFAULT only fires on INSERT).
    () => db.exec(`CREATE TABLE IF NOT EXISTS registrations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      submitted_at    TEXT,
      parent_first    TEXT,
      parent_last     TEXT,
      email           TEXT,
      mobile_norm     TEXT,
      whatsapp_norm   TEXT,
      children_json   TEXT,
      children_count  INTEGER,
      whatsapp_optin  INTEGER NOT NULL DEFAULT 0,
      optin_at        TEXT,
      optin_version   TEXT,
      photo_consent   INTEGER NOT NULL DEFAULT 0,
      tc_accepted     INTEGER NOT NULL DEFAULT 0,
      qid             TEXT,
      start_when      TEXT,
      client_type     TEXT,
      raw_row_hash    TEXT NOT NULL UNIQUE,
      needs_review    INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    )`),
    () => db.exec(`CREATE INDEX IF NOT EXISTS idx_reg_optin    ON registrations(whatsapp_optin)`),
    () => db.exec(`CREATE INDEX IF NOT EXISTS idx_reg_whatsapp ON registrations(whatsapp_norm)`),
    () => db.exec(`CREATE INDEX IF NOT EXISTS idx_reg_review   ON registrations(needs_review)`),

    // v22: broadcast infrastructure (B1) — additive. Recipients come from
    // `registrations` (deduped by whatsapp_norm via getOptedInRecipients), NOT
    // from leads — so client_messages carries recipient_phone (= whatsapp_norm,
    // the same identity R3 uses) as the per-recipient key; lead_id stays NULL on
    // broadcast rows.
    //   status lifecycle: draft → sending → done | failed; failed → sending on
    //   resume; canceled is a terminal operator stop.
    //   updated_at DEFAULT fires ONLY on INSERT — the B4 dispatcher MUST write
    //   updated_at explicitly on every UPDATE (status/sent mutations). Same as v21.
    () => db.exec(`CREATE TABLE IF NOT EXISTS broadcasts (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      status               TEXT NOT NULL DEFAULT 'draft',
      segment_kind         TEXT NOT NULL,
      segment_value        TEXT,
      segment_min          INTEGER,
      segment_max          INTEGER,
      channel              TEXT NOT NULL,
      body_kind            TEXT NOT NULL,
      text                 TEXT,
      template_name        TEXT,
      template_params_json TEXT,
      total                INTEGER NOT NULL DEFAULT 0,
      sent                 INTEGER NOT NULL DEFAULT 0,
      failed_count         INTEGER NOT NULL DEFAULT 0,
      created_at           TEXT DEFAULT (datetime('now')),
      updated_at           TEXT DEFAULT (datetime('now')),
      started_at           TEXT,
      finished_at          TEXT
    )`),
    // broadcasts must exist before the REFERENCES column is added. ADD COLUMN
    // with a REFERENCES clause is allowed by SQLite only when the new column's
    // default is NULL — which it is (no DEFAULT given).
    () => db.exec(`ALTER TABLE client_messages ADD COLUMN broadcast_id INTEGER REFERENCES broadcasts(id)`),
    () => db.exec(`ALTER TABLE client_messages ADD COLUMN recipient_phone TEXT`),
    () => db.exec(`CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts(status)`),
    () => db.exec(`CREATE INDEX IF NOT EXISTS idx_client_msgs_broadcast ON client_messages(broadcast_id, recipient_phone)`),
    // One row per (broadcast, recipient) → INSERT OR IGNORE makes a resend a
    // no-op (the B5 idempotency/resume backbone). Partial: only broadcast rows.
    () => db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cm_broadcast_recipient
                   ON client_messages(broadcast_id, recipient_phone) WHERE broadcast_id IS NOT NULL`),
    // child_age persisted for lead segmentation / age-based nurture. Independent
    // of the broadcast age-segment (that derives from registrations dob).
    () => db.exec(`ALTER TABLE leads ADD COLUMN child_age TEXT`),
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
  // lead_uid defaulted so older callers (without the field) keep working.
  return db.prepare(`
    INSERT OR IGNORE INTO leads
      (sheet_row_number, lead_uid, timestamp, parent_name, parent_phone, parent_whatsapp,
       parent_email, qid, language, client_type,
       phone_normalized, whatsapp_normalized, email_normalized,
       ref_lead_id, raw_data, status)
    VALUES
      (@sheet_row_number, @lead_uid, @timestamp, @parent_name, @parent_phone, @parent_whatsapp,
       @parent_email, @qid, @language, @client_type,
       @phone_normalized, @whatsapp_normalized, @email_normalized,
       @ref_lead_id, @raw_data, @status)
  `).run({ lead_uid: null, ...lead });
}

function getLeadByRow(sheetRowNumber) {
  return getDb().prepare('SELECT * FROM leads WHERE sheet_row_number = ?').get(sheetRowNumber);
}

function getLeadByUid(leadUid) {
  return getDb().prepare('SELECT * FROM leads WHERE lead_uid = ?').get(leadUid);
}

function updateLeadStatus(sheetRowNumber, updates) {
  const db = getDb();
  const fields = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  return db.prepare(`
    UPDATE leads SET ${fields}, updated_at = datetime('now')
    WHERE sheet_row_number = @sheet_row_number
  `).run({ ...updates, sheet_row_number: sheetRowNumber });
}

// Preferred over updateLeadStatus: works for uid leads too, whose
// sheet_row_number is NULL (canonical-sheet rows can shift; rows 2..13 are
// already taken by legacy leads from the old form).
function updateLeadStatusById(id, updates) {
  const db = getDb();
  const fields = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  return db.prepare(`
    UPDATE leads SET ${fields}, updated_at = datetime('now')
    WHERE id = @id
  `).run({ ...updates, id });
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

/**
 * Client-type breakdown for a date range (Qatar local time, +3h offset).
 * Returns [{client_type: string, cnt: N}, ...]
 */
function getTypeBreakdownInRange(startDate, endDate) {
  return getDb().prepare(`
    SELECT client_type, COUNT(*) as cnt
    FROM leads
    WHERE DATE(datetime(created_at, '+3 hours')) BETWEEN ? AND ?
      AND client_type != 'legacy'
    GROUP BY client_type
  `).all(startDate, endDate);
}

/**
 * Source breakdown for new leads in a date range (Qatar local time).
 * Returns [{source: string, cnt: N}, ...] ordered by cnt DESC.
 */
function getSourceBreakdownInRange(startDate, endDate) {
  return getDb().prepare(`
    SELECT COALESCE(NULLIF(TRIM(source), ''), 'Unknown') as source, COUNT(*) as cnt
    FROM leads
    WHERE DATE(datetime(created_at, '+3 hours')) BETWEEN ? AND ?
      AND client_type = 'new'
    GROUP BY COALESCE(NULLIF(TRIM(source), ''), 'Unknown')
    ORDER BY cnt DESC
  `).all(startDate, endDate);
}

/**
 * Response quality stats for new leads in a date range.
 * Returns: { avg_seconds: number|null, total_responded: number, within_hour: number, pending_24h: number }
 */
function getQualityStatsInRange(startDate, endDate) {
  const db = getDb();

  const resp = db.prepare(`
    SELECT
      AVG(CAST((julianday(responded_at) - julianday(notified_at)) * 86400 AS INTEGER)) AS avg_seconds,
      COUNT(*) AS total_responded,
      SUM(CASE WHEN (julianday(responded_at) - julianday(notified_at)) * 24 <= 1 THEN 1 ELSE 0 END) AS within_hour
    FROM leads
    WHERE DATE(datetime(created_at, '+3 hours')) BETWEEN ? AND ?
      AND client_type = 'new'
      AND status = 'responded'
      AND responded_at IS NOT NULL
      AND notified_at IS NOT NULL
  `).get(startDate, endDate);

  const pend24 = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM leads
    WHERE DATE(datetime(created_at, '+3 hours')) BETWEEN ? AND ?
      AND client_type = 'new'
      AND status = 'notified'
      AND notified_at <= datetime('now', '-24 hours')
  `).get(startDate, endDate);

  return {
    avg_seconds:     resp.avg_seconds     || null,
    total_responded: resp.total_responded || 0,
    within_hour:     resp.within_hour     || 0,
    pending_24h:     pend24.cnt,
  };
}

// ─────────────────────────────────────────────────────────────
// Agent 3 — nurture
// ─────────────────────────────────────────────────────────────

/** Persists raw child DOB strings (JSON array) for a lead. Additive, like source. */
function updateLeadChildrenDob(leadId, childrenDobJson) {
  return getDb().prepare(
    `UPDATE leads SET children_dob = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(childrenDobJson, leadId);
}

/**
 * Leads eligible for nurture that aren't enrolled yet.
 * Rule (Phase 1): status NOT LIKE 'duplicate_%' AND client_type ∈ {new,unknown,returning,existing}
 * (the IN-set excludes 'legacy'; the status filter excludes every duplicate_* regardless of type).
 */
function getNurtureEligibleLeads() {
  return getDb().prepare(`
    SELECT l.* FROM leads l
    WHERE l.status NOT LIKE 'duplicate_%'
      AND l.client_type IN ('new', 'unknown', 'returning', 'existing')
      AND NOT EXISTS (SELECT 1 FROM nurture_enrollments n WHERE n.lead_id = l.id)
    ORDER BY l.id ASC
  `).all();
}

/** Inserts an enrollment; no-op if the lead is already enrolled (lead_id UNIQUE). */
function insertNurtureEnrollment(e) {
  return getDb().prepare(`
    INSERT OR IGNORE INTO nurture_enrollments
      (lead_id, audience, audience_auto, audience_override,
       age_segment, children_count, children_json, status)
    VALUES
      (@lead_id, @audience, @audience_auto, @audience_override,
       @age_segment, @children_count, @children_json, @status)
  `).run(e);
}

function getNurtureEnrollmentByLeadId(leadId) {
  return getDb().prepare('SELECT * FROM nurture_enrollments WHERE lead_id = ?').get(leadId) || null;
}

/**
 * Sets a manual audience override and recomputes the effective audience.
 * Override wins over the derived value. Pass null to clear it (fall back to auto).
 */
function setNurtureOverride(leadId, override) {
  const row = getNurtureEnrollmentByLeadId(leadId);
  if (!row) return { changes: 0 };
  const effective = override || row.audience_auto;
  return getDb().prepare(`
    UPDATE nurture_enrollments
    SET audience_override = ?, audience = ?, updated_at = datetime('now')
    WHERE lead_id = ?
  `).run(override, effective, leadId);
}

/**
 * Active enrollments still owed their Phase-1 first-touch (no nurture message
 * queued yet). Joined with lead contact fields so the queue card can be built.
 */
function getNurtureQueueCandidates(limit = 100) {
  return getDb().prepare(`
    SELECT
      n.id            AS enrollment_id,
      n.lead_id       AS lead_id,
      n.audience      AS audience,
      n.age_segment   AS age_segment,
      n.children_count AS children_count,
      l.parent_name   AS parent_name,
      l.parent_phone  AS parent_phone,
      l.parent_whatsapp AS parent_whatsapp,
      l.parent_email  AS parent_email,
      l.language      AS language
    FROM nurture_enrollments n
    JOIN leads l ON l.id = n.lead_id
    WHERE n.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM client_messages m
        WHERE m.lead_id = n.lead_id AND m.message_type = 'nurture'
      )
    ORDER BY n.id ASC
    LIMIT ?
  `).all(limit);
}

/** Enrollment counts by effective audience — visibility for the owner summary. */
function getNurtureAudienceCounts() {
  return getDb().prepare(`
    SELECT audience, COUNT(*) AS cnt
    FROM nurture_enrollments
    WHERE status = 'active'
    GROUP BY audience
  `).all();
}

/**
 * Delivery stats for nurture messages created on a given Qatar-local date.
 * Returns { total, confirmed, pending } where pending = queued/sent-but-unconfirmed.
 */
function getNurtureDeliveryStats(dateStr) {
  const row = getDb().prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN delivery_status = 'confirmed_sent' THEN 1 ELSE 0 END) AS confirmed
    FROM client_messages
    WHERE message_type = 'nurture'
      AND DATE(datetime(created_at, '+3 hours')) = ?
  `).get(dateStr);
  const total     = row.total     || 0;
  const confirmed = row.confirmed || 0;
  return { total, confirmed, pending: total - confirmed };
}

// ─────────────────────────────────────────────────────────────
// registrations (R3) — projection of the big enrollment form.
// raw_row_hash = canonical content hash; conflict means an identical row, so
// upsert is insert-or-ignore (DO NOTHING) — re-reading the sheet never dups
// and never churns updated_at. (Poller liveness is a heartbeat, not updated_at.)
// ─────────────────────────────────────────────────────────────

const REG_COLS = [
  'submitted_at', 'parent_first', 'parent_last', 'email', 'mobile_norm',
  'whatsapp_norm', 'children_json', 'children_count', 'whatsapp_optin', 'optin_at',
  'optin_version', 'photo_consent', 'tc_accepted', 'qid', 'start_when',
  'client_type', 'raw_row_hash', 'needs_review',
];

/** Insert a mapped registration; no-op if its raw_row_hash already exists. */
function upsertRegistration(reg) {
  const res = getDb().prepare(`
    INSERT INTO registrations (${REG_COLS.join(', ')})
    VALUES (${REG_COLS.map(c => '@' + c).join(', ')})
    ON CONFLICT(raw_row_hash) DO NOTHING
  `).run(reg);
  return res.changes > 0
    ? { action: 'inserted', id: res.lastInsertRowid }
    : { action: 'skipped' };
}

/** Inspection helper: optional equality filters on a few columns. */
function getRegistrations(filter = {}) {
  const where = [], params = {};
  for (const k of ['needs_review', 'whatsapp_optin', 'client_type']) {
    if (filter[k] !== undefined) { where.push(`${k} = @${k}`); params[k] = filter[k]; }
  }
  return getDb().prepare(
    `SELECT * FROM registrations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY submitted_at`
  ).all(params);
}

// dob → age (inline to avoid a circular require with nurture). Mirrors nurture.
function _regAge(dobRaw, now = new Date()) {
  if (!dobRaw) return null;
  const d = new Date(String(dobRaw).trim());
  if (isNaN(d)) return null;
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const md = now.getUTCMonth() - d.getUTCMonth();
  if (md < 0 || (md === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}
function _anyChildInBand(childrenJson, min, max) {
  let kids = [];
  try { kids = JSON.parse(childrenJson).children || []; } catch { return false; }
  return kids.some(c => { const a = _regAge(c.dob); return a != null && a >= min && a <= max; });
}

/**
 * Broadcast audience: opted-in, reviewed-clean, with a usable WhatsApp number,
 * de-duplicated by whatsapp_norm (latest submission wins — most current data).
 * @param {object} segment { kind:'all' } | { kind:'client_type', value } | { kind:'age', min, max }
 */
function getOptedInRecipients(segment = { kind: 'all' }) {
  const where = ['whatsapp_optin = 1', 'needs_review = 0', "whatsapp_norm IS NOT NULL", "whatsapp_norm <> ''"];
  const params = {};
  if (segment.kind === 'client_type' && segment.value) { where.push('client_type = @ctype'); params.ctype = segment.value; }

  let rows = getDb().prepare(`SELECT * FROM registrations WHERE ${where.join(' AND ')}`).all(params);

  // age — derived from children_json dob on demand (not stored): keep a row if
  // ANY of its children falls in the band (message is to the parent).
  if (segment.kind === 'age' && segment.min != null && segment.max != null) {
    rows = rows.filter(r => _anyChildInBand(r.children_json, segment.min, segment.max));
  }

  // de-dup by phone — latest submitted_at wins.
  const byPhone = new Map();
  const ts = (s) => { const t = Date.parse(String(s || '')); return isNaN(t) ? 0 : t; };
  for (const r of rows) {
    const prev = byPhone.get(r.whatsapp_norm);
    if (!prev || ts(r.submitted_at) >= ts(prev.submitted_at)) byPhone.set(r.whatsapp_norm, r);
  }
  return [...byPhone.values()];
}

// ─────────────────────────────────────────────────────────────
// Broadcast dispatch (B4) — broadcasts row lifecycle + per-recipient log.
// updated_at is written EXPLICITLY on every UPDATE (DEFAULT fires on INSERT only).
// ─────────────────────────────────────────────────────────────

function createBroadcast(b) {
  const info = getDb().prepare(`
    INSERT INTO broadcasts
      (status, segment_kind, segment_value, segment_min, segment_max,
       channel, body_kind, text, total)
    VALUES
      ('draft', @segment_kind, @segment_value, @segment_min, @segment_max,
       @channel, @body_kind, @text, @total)
  `).run({
    segment_kind: b.segment_kind, segment_value: b.segment_value ?? null,
    segment_min: b.segment_min ?? null, segment_max: b.segment_max ?? null,
    channel: b.channel, body_kind: b.body_kind || 'text', text: b.text ?? null,
    total: b.total ?? 0,
  });
  return info.lastInsertRowid;
}

function getBroadcast(id) {
  return getDb().prepare('SELECT * FROM broadcasts WHERE id = ?').get(id);
}

// Atomic draft→sending. Returns true IFF this call made the transition
// (changes===1). A racing/duplicate start sees changes===0 → caller aborts.
function startBroadcast(id) {
  const info = getDb().prepare(`
    UPDATE broadcasts
       SET status='sending', started_at=datetime('now'), updated_at=datetime('now')
     WHERE id=? AND status='draft'
  `).run(id);
  return info.changes === 1;
}

function finishBroadcast(id, { status, sent, failed }) {
  getDb().prepare(`
    UPDATE broadcasts
       SET status=@status, sent=@sent, failed_count=@failed,
           finished_at=datetime('now'), updated_at=datetime('now')
     WHERE id=@id
  `).run({ id, status, sent, failed });
}

// Per-recipient log. INSERT OR IGNORE on UNIQUE(broadcast_id, recipient_phone)
// (B1) → a re-run never double-logs (B5 resume foundation). lead_id is NULL —
// broadcast recipients are registrations, not leads. delivery_status: 'sent' on
// success, 'failed' on send error (variant A — the failed row records WHO).
// B5 resume semantics: resend WHERE delivery_status != 'sent'; a later success
// is an UPDATE failed→sent (built in B5). Returns true if a row was inserted.
function logBroadcastRecipient(r) {
  const info = getDb().prepare(`
    INSERT OR IGNORE INTO client_messages
      (lead_id, broadcast_id, recipient_phone, message_type, text, language,
       channel, delivery_status, agent_name, sent_at)
    VALUES
      (NULL, @broadcast_id, @recipient_phone, 'broadcast', @text, @language,
       @channel, @delivery_status, 'broadcast', datetime('now'))
  `).run({
    broadcast_id: r.broadcast_id, recipient_phone: r.recipient_phone,
    text: r.text ?? null, language: r.language ?? null,
    channel: r.channel, delivery_status: r.delivery_status,
  });
  return info.changes === 1;
}

module.exports = {
  getDb,
  insertLead,
  upsertRegistration,
  getRegistrations,
  getOptedInRecipients,
  createBroadcast,
  getBroadcast,
  startBroadcast,
  finishBroadcast,
  logBroadcastRecipient,
  updateLeadChildrenDob,
  getNurtureEligibleLeads,
  insertNurtureEnrollment,
  getNurtureEnrollmentByLeadId,
  setNurtureOverride,
  getNurtureQueueCandidates,
  getNurtureAudienceCounts,
  getNurtureDeliveryStats,
  getLeadByRow,
  getLeadByUid,
  getLeadById,
  getYesterdayResponded,
  updateLeadStatus,
  updateLeadStatusById,
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
  getTypeBreakdownInRange,
  getSourceBreakdownInRange,
  getQualityStatsInRange,
};
