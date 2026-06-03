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
  getNurtureQueueCandidates,
  getNurtureAudienceCounts,
  getNurtureDeliveryStats,
} = require('./db');

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
 * Builds the full child set from raw DOB strings — NOTHING is dropped.
 * Returns { childrenCount, children: [{dob, age, segment}], ageSegment } where
 * ageSegment is the YOUNGEST child's segment (a temporary default for the single
 * service field; multi-child tone is a Phase 2 decision and does not limit what
 * we collect here).
 */
function buildChildren(rawDobList, now = new Date()) {
  const list = Array.isArray(rawDobList) ? rawDobList : [];
  const children = list.map((raw) => {
    const dob = parseDob(raw);
    const age = ageFromDob(dob, now);
    return { dob: raw, age, segment: segmentForAge(age) };
  });

  // Youngest = greatest age value is OLDEST; youngest = smallest age.
  const ages = children.map(c => c.age).filter(a => a != null && Number.isFinite(a));
  const ageSegment = ages.length ? segmentForAge(Math.min(...ages)) : 'unknown';

  return { childrenCount: children.length, children, ageSegment };
}

// ─────────────────────────────────────────────────────────────
// DOB extraction from a raw form row (used by lead-helper at parse time)
// ─────────────────────────────────────────────────────────────

/**
 * Pulls every non-empty "Child N – Date of Birth" cell from a form row.
 * The form branches by child count into separate column blocks, but only the
 * chosen branch is filled — so collecting all non-empty DOB columns yields
 * exactly that submission's children. Returns an array of raw strings (maybe []).
 */
function extractChildDobs(headers, values) {
  const out = [];
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] || '').toLowerCase();
    if (h.includes('child') && h.includes('date of birth')) {
      const v = (values[i] || '').trim();
      if (v) out.push(v);
    }
  }
  return out;
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
    let rawDobs = [];
    try {
      if (lead.children_dob) rawDobs = JSON.parse(lead.children_dob);
    } catch { rawDobs = []; }

    const { childrenCount, children, ageSegment } = buildChildren(rawDobs, now);
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

/** Phase-1 placeholder body. Real per-segment content is Phase 2. */
function placeholderText(candidate) {
  const tone = AUDIENCE_TONE[candidate.audience] || candidate.audience;
  return (
    `[NURTURE · Phase 1 placeholder]\n` +
    `Audience: ${tone}\n` +
    `Age segment: ${candidate.age_segment}\n` +
    `(Content lands in Phase 2 — this card verifies the pipe.)`
  );
}

/**
 * Builds the queue and delivers each item through the existing client pipe.
 * `deliver` is injectable so tests can stub the real send. Returns { queued }.
 */
async function buildAndSendQueue({ deliver = sendToClient, limit = 100 } = {}) {
  const candidates = getNurtureQueueCandidates(limit);
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
        metadata:    { agentName: 'nurture', leadId: c.lead_id },
      });
      queued++;
    } catch (err) {
      logger.error({ err, leadId: c.lead_id }, 'Nurture: queue delivery failed for lead');
    }
  }

  if (queued > 0) logger.info({ queued }, 'Nurture: queue items delivered to admins');
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
  extractChildDobs,
  deriveAudience,
  // pipe
  enrollEligibleLeads,
  buildAndSendQueue,
  buildOwnerSummaryText,
  sendOwnerSummary,
  runDaily,
};
