'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');
const { createLogger }      = require('../../shared/logger');
const { fetchAllResponses } = require('../../shared/sheets');
const { mapColumns }        = require('../../shared/column-mapper');
const { parseClientType }   = require('../../shared/client-type');
const { normalizePhone, normalizeEmail } = require('../../shared/normalize');
const { generateText }      = require('../../shared/claude');
const { sendToAdmin }       = require('../../shared/notify');
const {
  editMessage,
  registerCallback,
  startCallbackPolling,
} = require('../../shared/telegram');
const {
  getDb,
  insertLead,
  getLeadById,
  getLeadByRow,
  getLeadByUid,
  updateLeadStatusById,
  updateLeadGreeting,
  updateLeadChildrenDob,
  getLeadsNeedingReminder,
  findExistingLead,
} = require('../../shared/db');
const { markRespondedHandler, copyTextHandler } = require('../../shared/callbacks');
// Agent 3 nurture. Requiring this also registers the admin-side 'client_sent' /
// 'copy_text' callbacks (via client-messaging) in THIS process, which polls the
// Admin bot — so ✅ Sent on a nurture card is handled here. All nurture calls
// below are wrapped so a nurture failure never touches heartbeat or polling.
const nurture = require('../../shared/nurture');
const { writeHeartbeat } = require('../../shared/heartbeat');
const { buildGreetingPrompt } = require('./prompts');

// Test-only: freeze heartbeat writes while polling continues normally, so the
// watchdog's "online + stale = hung" branch can be exercised without dropping
// live leads. Never set in production.
const HEARTBEAT_FROZEN = process.env.HEARTBEAT_FREEZE === '1';

const logger = createLogger('lead-helper');

const POLL_INTERVAL  = parseInt(process.env.POLL_INTERVAL_SECONDS || '60', 10) * 1000;
const REMINDER_HOURS = parseInt(process.env.REMINDER_HOURS || '2', 10);

// In-memory cache: leadId (string) → greeting text, for the "📋 Copy" button
const _greetingCache = new Map();

// ─────────────────────────────────────────────────────────────
// Row parsing
// ─────────────────────────────────────────────────────────────

function parseRow(headers, values, colMap) {
  const get = (field) => {
    const idx = colMap[field];
    return idx !== undefined ? (values[idx] || '').trim() : '';
  };

  const parentName = [get('parent_first_name'), get('parent_last_name')]
    .filter(Boolean).join(' ').trim();

  const childIdx = headers.findIndex((h, i) => {
    const l = h.toLowerCase().trim();
    return l.includes('child') && l.includes('first name') && (values[i] || '').trim();
  });

  // Nurture: capture children as LINKED {first_name, last_name, dob} groups,
  // additively. Fully isolated — any failure leaves children_dob null and the
  // lead is processed exactly as before.
  let children_dob = null;
  try {
    const cap = nurture.extractChildren(headers, values);
    if (cap.children.length || cap.needs_review) children_dob = JSON.stringify(cap);
  } catch (err) {
    logger.warn({ err }, 'children_dob extraction failed — continuing without it');
  }

  return {
    parent_name:     parentName,
    parent_phone:    get('parent_phone'),
    parent_whatsapp: get('parent_whatsapp'),
    parent_email:    get('parent_email'),
    qid:             get('qid'),
    timestamp:       get('timestamp'),
    client_type:     parseClientType(get('client_type')),
    child_name:      childIdx !== -1 ? (values[childIdx] || '').trim() : '',
    child_age:       get('child_age') || null,
    children_dob,
    ready_date:      get('ready_date'),
    source:          get('source') || null,
    // Part A: stable lead identity from the n8n canonical sheet (null on the old form)
    lead_uid:        get('lead_uid') || null,
  };
}

// ─────────────────────────────────────────────────────────────
// Card builder
// ─────────────────────────────────────────────────────────────

function formatTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: process.env.TIMEZONE || 'Asia/Qatar',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

// Human-readable labels for known lead sources; unknown values shown as-is.
const SOURCE_LABELS = {
  website_form:       '🌐 Website form',
  instagram:          '📸 Instagram',
  instagram_lead_ads: '📸 Instagram ad',
};
function formatSource(src) {
  return SOURCE_LABELS[src] || src;
}

// Card is sent with parse_mode HTML — escape lead-controlled values so a
// "<", ">" or "&" in the data can't break Telegram's HTML parser (a real
// lead rarely has these, but a test lead's "<dummy>" data does).
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildCard(lead, rowNumber, opts = {}) {
  const { header, note } = opts;
  const lines = [header, ''];

  if (lead.parent_name)  lines.push(`👤 Name: ${escHtml(lead.parent_name)}`);
  if (lead.parent_phone) lines.push(`📱 Phone: ${escHtml(lead.parent_phone)}`);

  const wa = lead.parent_whatsapp || lead.parent_phone;
  if (wa)                lines.push(`💬 WhatsApp: ${escHtml(wa)}`);
  if (lead.parent_email) lines.push(`✉️ Email: ${escHtml(lead.parent_email)}`);
  if (lead.qid)          lines.push(`🆔 QID: ${escHtml(lead.qid)}`);
  if (lead.child_age)    lines.push(`🎂 Child age: ${escHtml(lead.child_age)}`);
  if (lead.source)       lines.push(`📍 Source: ${escHtml(formatSource(lead.source))}`);

  const receivedTs = lead.timestamp || lead.created_at || new Date().toISOString();
  lines.push(`⏰ Received: ${formatTime(receivedTs)}`);

  if (note) lines.push('', note);

  return lines.join('\n');
}

function respondedKeyboard(leadId) {
  return {
    inline_keyboard: [[
      { text: '✅ I responded',    callback_data: `responded:${leadId}` },
      { text: '📋 Copy text only', callback_data: `copy:${leadId}`      },
    ]],
  };
}

function contactedKeyboard(leadId) {
  return {
    inline_keyboard: [[
      { text: '✅ Contacted', callback_data: `responded:${leadId}` },
    ]],
  };
}

// ─────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────

function saveLead(rowNumber, parsed, phoneNorm, whatsappNorm, emailNorm, status, refLeadId = null) {
  const result = insertLead({
    // uid leads store NO row number: rows 2..13 are already taken by legacy
    // leads (UNIQUE + OR IGNORE would silently swallow them), and canonical
    // sheet rows can shift. lead_uid is the identity; rowNumber stays
    // display-only for uid leads.
    sheet_row_number:    parsed.lead_uid ? null : rowNumber,
    lead_uid:            parsed.lead_uid,
    timestamp:           parsed.timestamp,
    parent_name:         parsed.parent_name,
    parent_phone:        parsed.parent_phone,
    parent_whatsapp:     parsed.parent_whatsapp,
    parent_email:        parsed.parent_email,
    qid:                 parsed.qid,
    language:            'en',
    client_type:         parsed.client_type,
    phone_normalized:    phoneNorm,
    whatsapp_normalized: whatsappNorm,
    email_normalized:    emailNorm,
    ref_lead_id:         refLeadId,
    raw_data:            JSON.stringify({ parsed }),
    status,
  });
  // Save source if available (column might not exist in form yet)
  if (result && result.lastInsertRowid && parsed.source) {
    getDb().prepare(`UPDATE leads SET source = ? WHERE id = ?`)
      .run(parsed.source, result.lastInsertRowid);
  }
  // Nurture: persist raw child DOBs (isolated — never breaks the lead save).
  if (result && result.lastInsertRowid && parsed.children_dob) {
    try { updateLeadChildrenDob(result.lastInsertRowid, parsed.children_dob); }
    catch (err) { logger.warn({ err }, 'children_dob persist failed — lead saved without it'); }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// Sub-flows by client_type
// ─────────────────────────────────────────────────────────────

async function handleNew(rowNumber, parsed, phoneNorm, whatsappNorm, emailNorm, topNote = null) {
  const result = saveLead(rowNumber, parsed, phoneNorm, whatsappNorm, emailNorm, 'new');
  if (!result || result.changes === 0) return; // idempotency
  const leadId = result.lastInsertRowid;

  // Generate English greeting via Claude
  let greetingText = null;
  try {
    greetingText = await generateText(buildGreetingPrompt({ parentName: parsed.parent_name }));
    if (greetingText) {
      _greetingCache.set(String(leadId), greetingText);
      updateLeadGreeting(leadId, greetingText); // persist to DB — survives restarts
    }
  } catch (err) {
    logger.warn({ err }, 'Claude unavailable — sending card without draft');
  }

  const headerLine = topNote
    ? `${topNote}\n\n📩 <b>New Lead #${rowNumber}</b>`
    : `📩 <b>New Lead #${rowNumber}</b>`;

  const draft = greetingText
    ? `\n\n✍️ <b>Draft message for client:</b>\n${greetingText}`
    : '\n\n⚠️ Draft not generated — write manually.';

  const card = buildCard(parsed, rowNumber, { header: headerLine }) + draft;

  await sendToAdmin(card, { reply_markup: respondedKeyboard(leadId) });
  updateLeadStatusById(leadId, { status: 'notified', notified_at: new Date().toISOString() });
  logger.info({ rowNumber, leadId, client_type: parsed.client_type }, 'New lead — admin notified');
}

async function handleReturning(rowNumber, parsed, phoneNorm, whatsappNorm, emailNorm) {
  const result = saveLead(rowNumber, parsed, phoneNorm, whatsappNorm, emailNorm, 'returning_notified');
  if (!result || result.changes === 0) return;
  const leadId = result.lastInsertRowid;

  const header = `↩️ <b>Returning Client — Lead #${rowNumber}</b>`;
  const note   = '<i>This person has been with us before. Contact personally to discuss return terms.</i>';
  const card   = buildCard(parsed, rowNumber, { header, note });

  await sendToAdmin(card, { reply_markup: contactedKeyboard(leadId) });
  updateLeadStatusById(leadId, { status: 'returning_notified', notified_at: new Date().toISOString() });
  logger.info({ rowNumber, leadId }, 'Returning client — admin notified');
}

// ─────────────────────────────────────────────────────────────
// Main row processor (dedup → route by client_type)
// ─────────────────────────────────────────────────────────────

async function processNewRow(rowNumber, headers, values, colMap) {
  const parsed = parseRow(headers, values, colMap);

  const phoneNorm    = normalizePhone(parsed.parent_phone);
  const whatsappNorm = normalizePhone(parsed.parent_whatsapp);
  const emailNorm    = normalizeEmail(parsed.parent_email);

  // ── DEDUPLICATION ─────────────────────────────────────────
  const dup = findExistingLead({ phoneNorm, whatsappNorm, emailNorm, qid: parsed.qid });

  if (dup) {
    const daysSince = Math.floor((Date.now() - new Date(dup.created_at).getTime()) / 86400000);
    const dupType   = dup.client_type;

    // Existing / returning member re-submitted — store silently
    if (['existing', 'existing_signed', 'returning', 'returning_notified'].includes(dupType)) {
      const status = dupType.startsWith('existing') ? 'duplicate_of_existing' : 'duplicate_of_returning';
      saveLead(rowNumber, parsed, phoneNorm, whatsappNorm, emailNorm, status, dup.id);
      logger.info(
        { rowNumber, dupId: dup.id, dupType, name: parsed.parent_name },
        `Duplicate of ${dupType} — stored silently as ${status}`
      );
      return;
    }

    // Recent duplicate of new/unknown (< 30 days) — short alert, no card
    if (daysSince < 30) {
      saveLead(rowNumber, parsed, phoneNorm, whatsappNorm, emailNorm, 'duplicate_recent_lead', dup.id);
      await sendToAdmin(
        `⚠️ <b>Duplicate form submission</b>\n` +
        `👤 ${parsed.parent_name || '(no name)'} submitted the form again.\n` +
        `Previous lead: #${dup.sheet_row_number ?? dup.id}, ${daysSince} day(s) ago.\n` +
        `Previous status: ${dup.status}`
      );
      logger.info({ rowNumber, dupId: dup.id, daysSince }, 'Duplicate recent lead — short alert sent');
      return;
    }

    // Re-entry after 30+ days — full flow with re-entry note
    const note =
      `🔁 <i>Re-entry: previously submitted on ${formatTime(dup.created_at)}. ` +
      `Previous status: ${dup.status}.</i>`;
    await handleNew(rowNumber, parsed, phoneNorm, whatsappNorm, emailNorm, note);
    return;
  }

  // ── ROUTE BY CLIENT TYPE ───────────────────────────────────
  if (parsed.client_type === 'existing') {
    saveLead(rowNumber, parsed, phoneNorm, whatsappNorm, emailNorm, 'existing_signed');
    logger.info(
      { rowNumber, name: parsed.parent_name, phone: parsed.parent_phone },
      `Existing member signed T&C: ${parsed.parent_name}, phone: ${parsed.parent_phone}`
    );
    return;
  }

  if (parsed.client_type === 'returning') {
    await handleReturning(rowNumber, parsed, phoneNorm, whatsappNorm, emailNorm);
    return;
  }

  // 'new' or 'unknown'
  const unknownNote = parsed.client_type === 'unknown'
    ? '⚠️ <b>Client type missing — please verify form data</b>'
    : null;
  await handleNew(rowNumber, parsed, phoneNorm, whatsappNorm, emailNorm, unknownNote);
}

// ─────────────────────────────────────────────────────────────
// Sheets polling
// ─────────────────────────────────────────────────────────────

let _colMap = null;

async function pollSheets() {
  logger.debug('Polling Google Sheets...');
  let rows;

  try {
    rows = await fetchAllResponses();
  } catch (err) {
    logger.error({ err }, 'Failed to read Google Sheets');
    return; // no heartbeat — staleness lets the watchdog catch a silent Google/Sheets stall
  }

  // Reached Google Sheets successfully — this counts as a healthy cycle even if 0 rows.
  if (!HEARTBEAT_FROZEN) {
    try { writeHeartbeat('lead-helper', `sheets ok, ${rows ? rows.length : 0} rows`); }
    catch (err) { logger.warn({ err }, 'writeHeartbeat failed'); }
  }

  if (!rows || rows.length === 0) return;

  if (!_colMap) {
    _colMap = mapColumns(rows[0].headers);
    logger.debug({ colMap: _colMap }, 'Column map initialized');
  }

  for (const { rowNumber, headers, values } of rows) {
    // Skip empty rows
    const hasData = ['parent_first_name', 'parent_phone', 'parent_email'].some(field => {
      const idx = _colMap[field];
      return idx !== undefined && (values[idx] || '').trim();
    });
    if (!hasData) continue;

    // Dedup: uid leads (canonical sheet) by stable lead_uid — immune to row
    // shifts and to the legacy row-number collision (rows 2..13). Old-form
    // rows (no uid column) keep the row-number dedup — instant rollback path.
    const uidIdx = _colMap.lead_uid;
    const uid = uidIdx !== undefined ? (values[uidIdx] || '').trim() : '';
    if (uid ? getLeadByUid(uid) : getLeadByRow(rowNumber)) continue;

    try {
      await processNewRow(rowNumber, headers, values, _colMap);
    } catch (err) {
      logger.error({ err, rowNumber }, 'Error processing row');
      await sendToAdmin(`🚨 Lead-helper error on row #${rowNumber}\n<code>${err.message}</code>`).catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Reminders
// ─────────────────────────────────────────────────────────────

async function checkReminders() {
  logger.debug('Checking reminders...');
  let leads;

  try {
    leads = getLeadsNeedingReminder(REMINDER_HOURS);
  } catch (err) {
    logger.error({ err }, 'Failed to fetch reminder leads');
    return;
  }

  for (const lead of leads) {
    try {
      const label  = lead.sheet_row_number ?? lead.id; // uid leads have no row number
      const header = `⏰ <b>Reminder: Lead #${label} still waiting (${REMINDER_HOURS}h)</b>`;
      const card   = buildCard(lead, label, { header });
      await sendToAdmin(card, { reply_markup: respondedKeyboard(lead.id) });
      updateLeadStatusById(lead.id, { reminder_sent_at: new Date().toISOString() });
      logger.info({ leadId: lead.id, rowNumber: lead.sheet_row_number }, 'Reminder sent');
    } catch (err) {
      logger.error({ err, leadId: lead.id }, 'Error sending reminder');
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Callbacks (inline buttons)
// ─────────────────────────────────────────────────────────────

function setupCallbacks() {
  // "✅ I responded" / "✅ Contacted" — shared handler from callbacks.js
  registerCallback('responded', markRespondedHandler('admin'));

  // "📋 Copy text only" — reads from DB first, then in-memory cache
  registerCallback('copy', copyTextHandler(_greetingCache));
}

// ─────────────────────────────────────────────────────────────
// Single-instance lock (daemon mode only)
// ─────────────────────────────────────────────────────────────
const LOCK_FILE = path.join(__dirname, '../../data/lead-helper.lock');

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    const existingPid = parseInt(raw, 10);
    if (!isNaN(existingPid)) {
      try {
        process.kill(existingPid, 0); // throws ESRCH if dead
        console.error(`[lead-helper] Already running as PID ${existingPid}. Exiting.`);
        process.exit(1);
      } catch {
        // Stale lock — previous process is gone
        console.warn(`[lead-helper] Stale lock (PID ${existingPid} dead). Overwriting.`);
      }
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────

async function start() {
  acquireLock();
  logger.info({ pollInterval: `${POLL_INTERVAL / 1000}s`, reminderHours: REMINDER_HOURS, pid: process.pid }, 'Lead-helper starting');

  setupCallbacks();
  startCallbackPolling();

  await pollSheets();

  setInterval(async () => {
    await pollSheets().catch(err => logger.error({ err }, 'pollSheets unhandled'));
  }, POLL_INTERVAL);

  cron.schedule('*/10 * * * *', async () => {
    await checkReminders().catch(err => logger.error({ err }, 'checkReminders unhandled'));
  });

  // ── Nurture daily run 08:00 Doha (Agent 3, Phase 1) ──
  // Off the pollSheets/heartbeat path and double-guarded: a nurture failure is
  // logged and contained, never propagating into the lead-helper core loop.
  cron.schedule('0 8 * * *', async () => {
    try {
      await nurture.runDaily();
    } catch (err) {
      logger.error({ err }, 'nurture.runDaily failed — core loop unaffected');
    }
  }, { timezone: process.env.TIMEZONE || 'Asia/Qatar' });

  logger.info('Lead-helper running ✅');
}

process.on('SIGTERM', () => { logger.info('SIGTERM received'); releaseLock(); process.exit(0); });
process.on('SIGINT',  () => { logger.info('SIGINT received');  releaseLock(); process.exit(0); });
process.on('exit',    ()  => { releaseLock(); });
process.on('uncaughtException', async (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  await sendToAdmin(`🚨 Lead-helper crashed: <code>${err.message}</code>`).catch(() => {});
  process.exit(1);
});
process.on('unhandledRejection', async (reason) => {
  logger.error({ reason }, 'Unhandled rejection');
  await sendToAdmin(`🚨 Lead-helper unhandled rejection: <code>${reason}</code>`).catch(() => {});
});

start().catch(async (err) => {
  logger.fatal({ err }, 'Failed to start');
  await sendToAdmin(`🚨 Lead-helper failed to start: <code>${err.message}</code>`).catch(() => {});
  process.exit(1);
});
