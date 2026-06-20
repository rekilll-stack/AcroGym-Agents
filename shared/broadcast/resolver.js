'use strict';

/**
 * Broadcast audience resolver (B2) — a thin, READ-ONLY layer over R3's
 * getOptedInRecipients. It does NOT re-implement selection: opt-in gating,
 * needs_review exclusion, usable-phone filtering, age "any child in band", and
 * de-dup by whatsapp_norm all live in getOptedInRecipients. Here we only:
 *   - bridge a broadcast segment spec → the {kind,...} shape R3 expects,
 *   - project each registration row to the minimal recipient shape,
 *   - mask the phone for preview / dry-run / logs.
 *
 * Nothing is sent and nothing is written — selection + formatting only (B2).
 * The full number (recipient_phone) is for the dispatcher (B4) and as the
 * client_messages.recipient_phone resume key; preview surfaces phone_masked.
 */

const { getOptedInRecipients } = require('../db');

/**
 * Mask a WhatsApp number for display: country code + 2 last digits, e.g.
 * 97455500001 → "974•••••01". Enough to eyeball an audience, not enough to leak
 * the number. Fixed 5 bullets (a mask, not a length-accurate redaction).
 */
function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 5) return '•••••'; // too short to mask meaningfully
  return `${d.slice(0, 3)}•••••${d.slice(-2)}`;
}

/**
 * Bridge a broadcast segment (B1 columns: kind/value/min/max) to the shape
 * getOptedInRecipients expects. Defaults to {kind:'all'}.
 */
function toR3Segment(segment = {}) {
  const kind = segment.kind || 'all';
  if (kind === 'client_type') return { kind: 'client_type', value: segment.value };
  if (kind === 'age')         return { kind: 'age', min: segment.min, max: segment.max };
  return { kind: 'all' };
}

/**
 * Resolve the audience for a segment.
 * @returns {{ segment: object, total: number, recipients: Array<{
 *   recipient_phone: string,  // full whatsapp_norm — dispatch + resume key
 *   display_name: string,     // parent_first only (minimise PII in preview)
 *   phone_masked: string      // 974•••••01 — for preview / dry-run / logs
 * }> }}
 */
function resolveAudience(segment = { kind: 'all' }) {
  const rows = getOptedInRecipients(toR3Segment(segment)); // read-only SELECT
  const recipients = rows.map(r => ({
    recipient_phone: r.whatsapp_norm,
    display_name:    r.parent_first || '',
    phone_masked:    maskPhone(r.whatsapp_norm),
  }));
  return { segment, total: recipients.length, recipients };
}

module.exports = { resolveAudience, maskPhone };
