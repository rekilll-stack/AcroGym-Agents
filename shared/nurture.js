'use strict';

/**
 * shared/nurture.js — Agent 3 (Pre-launch Nurture), Phase 1 core.
 *
 * Phase 1 builds the PIPE, not the content: a lead from the form is enrolled,
 * segmented (audience tone + age segment), delivered to the admin queue with a
 * ✅ Sent button, execution is counted, and the owner gets a summary. The queue
 * item is a placeholder — real content is Phase 2.
 *
 * Reuses the existing pipe: sendToClient → client_messages(type='nurture') →
 * 'client_sent' button → confirmed_sent. Nothing here touches lead-helper's
 * heartbeat or polling; all hooks are wrapped by the caller.
 */

const { createLogger } = require('./logger');
const { sendToOwner }  = require('./notify');
const { sendToClient } = require('./client-messaging');
const {
  getNurtureEligibleLeads,
  insertNurtureEnrollment,
  getDripCandidates,
  advanceDripTouch,
  getNurtureAudienceCounts,
  getNurtureDeliveryStats,
} = require('./db');

// Drip schedule (A.2): touch → day-offset from enrollment (day 0). Touch 1 is the
// welcome (lead-helper card); the drip owns touches 2+. Content is A.3 (placeholder
// here). 3 = last touch → series ends (next_touch NULL).
const TOUCHES = { 2: 3, 3: 7 };
const LAST_TOUCH = 3;

const logger = createLogger('nurture');

// ─────────────────────────────────────────────────────────────
// Date of birth → age → tone segment
// ─────────────────────────────────────────────────────────────

const SEGMENTS = [
  { min: 3,  max: 5,  label: '3-5'   },
  { min: 6,  max: 9,  label: '6-9'   },
  { min: 10, max: 14, label: '10-14' },
];

function segmentForAge(age) {
  if (age == null || !Number.isFinite(age)) return 'unknown';
  for (const s of SEGMENTS) if (age >= s.min && age <= s.max) return s.label;
  return 'unknown';
}

/**
 * Tolerant DOB parser. Form dates arrive in mixed shapes; for a *tone* segment
 * the year dominates, so M/D vs D/M ambiguity only matters at a birthday edge —
 * acceptable in Phase 1. Returns a Date or null (null → age_segment 'unknown').
 */
function parseDob(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  let y, m, d;

  // ISO: YYYY-MM-DD
  let mIso = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (mIso) {
    y = +mIso[1]; m = +mIso[2]; d = +mIso[3];
  } else {
    // D/M/Y or M/D/Y with /, -, or .
    const mSlash = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
    if (mSlash) {
      let a = +mSlash[1], b = +mSlash[2];
      y = +mSlash[3];
      if (y < 100) y += 2000;
      if (a > 12 && b <= 12)      { d = a; m = b; }   // unambiguous D/M
      else if (b > 12 && a <= 12) { m = a; d = b; }   // unambiguous M/D
      else                        { m = a; d = b; }   // ambiguous → assume M/D/Y
    } else {
      const t = Date.parse(s); // "May 12, 2019" etc.
      if (Number.isNaN(t)) return null;
      const dt = new Date(t);
      y = dt.getFullYear(); m = dt.getMonth() + 1; d = dt.getDate();
    }
  }

  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Reject impossible dates (e.g. 31 Feb rolled over) and implausible years.
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  const nowY = new Date().getUTCFullYear();
  if (y < 2000 || y > nowY) return null;
  return dt;
}

function ageFromDob(dob, now = new Date()) {
  if (!dob) return null;
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const mDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (mDiff < 0 || (mDiff === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

/**
 * Enriches a captured child set (from extractChildren) with age/segment.
 *
 * `captured` = { declared_count, children: [{first_name, last_name, dob,
 * needs_review}], needs_review }. NOTHING is dropped. Each child keeps its OWN
 * first_name/last_name/dob and gets its OWN, accurate `segment` (per-child).
 * `ageSegment` is a SEPARATE family-level field = the YOUNGEST child's segment;
 * "youngest" affects ONLY this family flag, never per-child data. Multi-child
 * family tone is a Phase 2 decision and does not limit what we collect here.
 *
 * Returns { childrenCount, children: [{first_name, last_name, dob, age, segment,
 * needs_review}], ageSegment, needsReview }.
 */
function buildChildren(captured, now = new Date()) {
  const cap  = normalizeCaptured(captured);
  const list = cap.children;

  const children = list.map((c) => {
    const dob = parseDob(c.dob);
    const age = ageFromDob(dob, now);
    const needs_review = !!c.needs_review || !String(c.first_name || '').trim() || !dob;
    return {
      first_name: String(c.first_name || '').trim(),
      last_name:  String(c.last_name  || '').trim(),
      dob:        c.dob || '',
      age,
      segment:    segmentForAge(age),   // per-child, accurate
      needs_review,
    };
  });

  // Family flag only: youngest = smallest age value.
  const ages = children.map(c => c.age).filter(a => a != null && Number.isFinite(a));
  const ageSegment = ages.length ? segmentForAge(Math.min(...ages)) : 'unknown';

  const needsReview = !!cap.needs_review || children.some(c => c.needs_review);

  return { childrenCount: children.length, children, ageSegment, needsReview };
}

/** Coerce stored children_dob into the captured shape (tolerant of old/array form). */
function normalizeCaptured(captured) {
  if (Array.isArray(captured)) {
    // Legacy/fallback: a bare array of dob strings (or child objects).
    const children = captured.map(x =>
      typeof x === 'string'
        ? { first_name: '', last_name: '', dob: x }
        : { first_name: x.first_name || '', last_name: x.last_name || '', dob: x.dob || '', needs_review: x.needs_review }
    );
    return { declared_count: null, children, needs_review: false };
  }
  if (captured && typeof captured === 'object') {
    return {
      declared_count: captured.declared_count ?? null,
      children:       Array.isArray(captured.children) ? captured.children : [],
      needs_review:   !!captured.needs_review,
    };
  }
  return { declared_count: null, children: [], needs_review: false };
}

// ─────────────────────────────────────────────────────────────
// Child extraction from a raw form row (used by lead-helper at parse time)
// ─────────────────────────────────────────────────────────────

/** Normalize a header: lowercase, en/em-dash → '-', collapse whitespace. */
function normHeader(h) {
  return String(h || '')
    .toLowerCase()
    .replace(/[‐-―]/g, '-')   // hyphen/figure/en/em dashes → '-'
    .replace(/\s+/g, ' ')
    .trim();
}

const CHILD_KIND = { 'first name': 'first', 'last name': 'last', 'date of birth': 'dob' };

/**
 * Extracts children as LINKED groups from a raw form row.
 *
 * The form is glued from several branches — one section per declared child count
 * — so the headers contain MULTIPLE "Child 1 – First Name" blocks (with en-dash
 * vs hyphen, double spaces, mixed case). Exactly one branch is filled per
 * submission. We:
 *   1. read N from the "how many children" column,
 *   2. tokenize child columns into {childNum, kind} (drift-tolerant via normHeader),
 *   3. group tokens into blocks (a new block starts at "Child 1 – First Name"),
 *   4. pick the FILLED block, and pair {first_name, last_name, dob} by childNum —
 *      so each child's name stays bound to its OWN date.
 *
 * needs_review is raised (never a silent unknown) when a child's name/dob is
 * missing/unparseable, or the filled block's child count ≠ N from the form.
 *
 * Returns { declared_count, children: [{first_name, last_name, dob, needs_review}],
 * needs_review }.
 */
function extractChildren(headers, values) {
  const hs = Array.isArray(headers) ? headers : [];
  const val = (i) => String((values && values[i]) || '').trim();

  // 1) declared count
  let declared_count = null;
  for (let i = 0; i < hs.length; i++) {
    const n = normHeader(hs[i]);
    if (n.includes('how many') && n.includes('child')) {
      const m = val(i).match(/\d+/);
      if (m) declared_count = parseInt(m[0], 10);
      break;
    }
  }

  // 2)+3) tokenize into blocks
  const blocks = [];
  let cur = null;
  for (let i = 0; i < hs.length; i++) {
    const n = normHeader(hs[i]);
    const m = n.match(/^child\s*(\d+)\b.*?(first name|last name|date of birth)/);
    if (!m) continue;
    const childNum = parseInt(m[1], 10);
    const kind = CHILD_KIND[m[2]];
    if (!kind) continue;
    if (childNum === 1 && kind === 'first') { cur = new Map(); blocks.push(cur); }
    if (!cur) { cur = new Map(); blocks.push(cur); }
    const slot = cur.get(childNum) || {};
    slot[kind] = i;
    cur.set(childNum, slot);
  }

  // 4) materialize each block, keep the filled one(s)
  const materialize = (block) => {
    const nums = [...block.keys()].sort((a, b) => a - b);
    const kids = [];
    for (const num of nums) {
      const s = block.get(num);
      const first = s.first != null ? val(s.first) : '';
      const last  = s.last  != null ? val(s.last)  : '';
      const dob   = s.dob   != null ? val(s.dob)   : '';
      if (first || dob || last) kids.push({ first_name: first, last_name: last, dob });
    }
    return kids;
  };

  const filled = blocks.map(materialize).filter(k => k.length > 0);

  let children = [];
  let multiBlock = false;
  if (filled.length === 1) children = filled[0];
  else if (filled.length > 1) { children = filled[0]; multiBlock = true; }

  // per-child needs_review: missing name or unparseable dob
  for (const c of children) {
    c.needs_review = !c.first_name || !parseDob(c.dob);
  }

  const countMismatch = declared_count != null && declared_count !== children.length;
  const needs_review =
    multiBlock ||
    countMismatch ||
    children.some(c => c.needs_review) ||
    (declared_count != null && declared_count > 0 && children.length === 0);

  return { declared_count, children, needs_review };
}

// ─────────────────────────────────────────────────────────────
// Audience derivation
// ─────────────────────────────────────────────────────────────

/** client_type → tone bucket. existing→enrolled, returning→warm, else cold. */
function deriveAudience(clientType) {
  if (clientType === 'existing') return 'enrolled';
  if (clientType === 'returning') return 'warm';
  return 'cold';
}

// ─────────────────────────────────────────────────────────────
// Enrollment
// ─────────────────────────────────────────────────────────────

/**
 * Enrolls every eligible, not-yet-enrolled lead. Idempotent: lead_id is UNIQUE,
 * so re-running never double-enrolls. Returns { enrolled, byAudience }.
 */
function enrollEligibleLeads(now = new Date()) {
  const leads = getNurtureEligibleLeads();
  let enrolled = 0;
  const byAudience = { cold: 0, warm: 0, enrolled: 0 };

  for (const lead of leads) {
    let captured = { declared_count: null, children: [], needs_review: false };
    try {
      if (lead.children_dob) captured = JSON.parse(lead.children_dob);
    } catch { captured = { declared_count: null, children: [], needs_review: false }; }

    const { childrenCount, children, ageSegment } = buildChildren(captured, now);
    const audienceAuto = deriveAudience(lead.client_type);

    const res = insertNurtureEnrollment({
      lead_id:           lead.id,
      audience:          audienceAuto,        // effective = auto until overridden
      audience_auto:     audienceAuto,
      audience_override: null,
      age_segment:       ageSegment,
      children_count:    childrenCount,
      children_json:     JSON.stringify(children),
      status:            'active',
    });

    if (res.changes > 0) {
      enrolled++;
      if (byAudience[audienceAuto] != null) byAudience[audienceAuto]++;
    }
  }

  if (enrolled > 0) logger.info({ enrolled, byAudience }, 'Nurture: leads enrolled');
  return { enrolled, byAudience };
}

// ─────────────────────────────────────────────────────────────
// Queue build + delivery
// ─────────────────────────────────────────────────────────────

const AUDIENCE_TONE = {
  cold:     'cold — introduce the center',
  warm:     'warm — welcome back',
  enrolled: 'enrolled — you are in, opening soon',
};

/** Placeholder body — real per-touch, per-segment content is A.3. */
function placeholderText(candidate) {
  const tone = AUDIENCE_TONE[candidate.audience] || candidate.audience;
  return (
    `[NURTURE · touch ${candidate.next_touch} placeholder]\n` +
    `Audience: ${tone}\n` +
    `Age segment: ${candidate.age_segment}\n` +
    `(Real per-touch content lands in A.3 — this card verifies the drip pipe.)`
  );
}

/**
 * Builds the drip queue and delivers each DUE touch to the admin (draft only —
 * the admin sends to the client by hand). After delivering touch N, advances the
 * enrollment to touch N+1 (next_due = enrolled + offset) or ends the series. Gates
 * + stop conditions live in getDripCandidates. `deliver` is injectable for tests.
 */
async function buildAndSendQueue({ deliver = sendToClient, limit = 100 } = {}) {
  const candidates = getDripCandidates(limit);
  let queued = 0;

  for (const c of candidates) {
    const lead = {
      parent_name:     c.parent_name,
      parent_phone:    c.parent_phone,
      parent_whatsapp: c.parent_whatsapp,
      parent_email:    c.parent_email,
      language:        c.language || 'en',
    };
    try {
      await deliver({
        lead,
        messageText: placeholderText(c),
        messageType: 'nurture',
        metadata:    { agentName: 'nurture', leadId: c.lead_id, touch: c.next_touch },
      });
      // Advance the sequence: schedule the next touch, or end the series.
      const delivered = c.next_touch;
      if (delivered >= LAST_TOUCH) {
        advanceDripTouch(c.enrollment_id, { nextTouch: null });
      } else {
        const nextTouch = delivered + 1;
        advanceDripTouch(c.enrollment_id, { nextTouch, enrolledAt: c.enrolled_at, offsetDays: TOUCHES[nextTouch] });
      }
      queued++;
    } catch (err) {
      logger.error({ err, leadId: c.lead_id }, 'Nurture: queue delivery failed for lead');
    }
  }

  if (queued > 0) logger.info({ queued }, 'Nurture: drip touches delivered to admins');
  return { queued };
}

// ─────────────────────────────────────────────────────────────
// Owner summary (execution loop visibility)
// ─────────────────────────────────────────────────────────────

function qatarDateStr(now = new Date()) {
  // +3h = Asia/Qatar (no DST), then take the calendar date.
  return new Date(now.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function buildOwnerSummaryText(now = new Date()) {
  const dateStr = qatarDateStr(now);
  const counts  = getNurtureAudienceCounts();
  const stats   = getNurtureDeliveryStats(dateStr);

  const byAud = { cold: 0, warm: 0, enrolled: 0 };
  for (const r of counts) if (byAud[r.audience] != null) byAud[r.audience] = r.cnt;
  const totalEnrolled = byAud.cold + byAud.warm + byAud.enrolled;

  return (
    `📊 <b>Nurture — execution summary</b>\n` +
    `Enrolled (active): <b>${totalEnrolled}</b> ` +
    `(cold ${byAud.cold} · warm ${byAud.warm} · enrolled ${byAud.enrolled})\n\n` +
    `📬 Today's queue: <b>${stats.total}</b>\n` +
    `✅ Sent: <b>${stats.confirmed}</b>\n` +
    `⏳ Awaiting: <b>${stats.pending}</b>`
  );
}

async function sendOwnerSummary(now = new Date()) {
  try {
    await sendToOwner(buildOwnerSummaryText(now), { parse_mode: 'HTML' });
  } catch (err) {
    logger.error({ err }, 'Nurture: owner summary send failed');
  }
}

// ─────────────────────────────────────────────────────────────
// Daily run (enroll → queue → summary)
// ─────────────────────────────────────────────────────────────

async function runDaily() {
  const now = new Date();
  const enroll = enrollEligibleLeads(now);
  const queue  = await buildAndSendQueue();
  await sendOwnerSummary(now);
  logger.info({ enrolled: enroll.enrolled, queued: queue.queued }, 'Nurture: daily run complete');
  return { ...enroll, ...queue };
}

module.exports = {
  // segmentation / parsing (pure — unit-testable)
  parseDob,
  ageFromDob,
  segmentForAge,
  buildChildren,
  extractChildren,
  deriveAudience,
  // pipe
  enrollEligibleLeads,
  buildAndSendQueue,
  buildOwnerSummaryText,
  sendOwnerSummary,
  runDaily,
};
