'use strict';

// Header-based mapper for the big enrollment form → registrations row.
// PURE: no DB writes. Maps by header SUBSTRING (never by column position — the
// form is glued from branches and gets edited, so positions are unstable).
// Children reuse extractChildren (linked name↔dob groups, branch-aware).

const crypto = require('crypto');
const { normalizePhone }  = require('../normalize');
const { extractChildren } = require('../nurture');

// Bump when the WhatsApp opt-in consent wording changes (App Review needs to
// know which version a person agreed to).
const OPTIN_VERSION = 'wa_v1';

function norm(h) {
  return String(h || '')
    .toLowerCase()
    .replace(/[‐-―]/g, '-')  // hyphen/figure/en/em dashes → '-'
    .replace(/\s+/g, ' ')
    .trim();
}

// First NON-EMPTY value among columns whose header matches pred. The form
// branches, so the unfilled branches' columns are empty — first-non-empty
// deterministically picks the column on the path the registrant actually took.
function firstNonEmpty(headers, values, pred) {
  for (let i = 0; i < headers.length; i++) {
    if (pred(norm(headers[i]))) {
      const v = String((values && values[i]) || '').trim();
      if (v) return v;
    }
  }
  return '';
}

// OR across matching columns: any non-empty → true (for branchy consent fields).
function anyNonEmpty(headers, values, pred) {
  for (let i = 0; i < headers.length; i++) {
    if (pred(norm(headers[i]))) {
      if (String((values && values[i]) || '').trim()) return true;
    }
  }
  return false;
}

function normClientType(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return null;
  if (s.includes('new')) return 'new';
  if (s.includes('exist') || s.includes('member')) return 'existing';
  return null;
}

/**
 * Maps one raw form row to a registrations object (no id/created_at — DB owns those).
 * @param {string[]} headers
 * @param {string[]} values
 */
function mapRow(headers, values) {
  const hs = Array.isArray(headers) ? headers : [];

  const submitted_at = firstNonEmpty(hs, values, n => n.includes('timestamp')) || null;
  const email        = firstNonEmpty(hs, values, n => n.includes('email')) || null;
  const parent_first = firstNonEmpty(hs, values, n => n.includes('first name') && n.includes('parent')) || null;
  const parent_last  = firstNonEmpty(hs, values, n => n.includes('last name')  && n.includes('parent')) || null;
  const mobileRaw    = firstNonEmpty(hs, values, n => n.includes('mobile number'));
  const waRaw        = firstNonEmpty(hs, values, n => n.includes('whatsapp number'));
  const qid          = firstNonEmpty(hs, values, n => n.includes('qid')) || null;
  const start_when   = firstNonEmpty(hs, values, n => n.includes('ready to start')) || null;
  const client_type  = normClientType(firstNonEmpty(hs, values, n => n.includes('new client') && n.includes('exist')));

  const mobile_norm   = normalizePhone(mobileRaw) || null;
  const whatsapp_norm = normalizePhone(waRaw) || normalizePhone(mobileRaw) || null;

  // opt-in: cell non-empty → consent (wording is versioned, so don't match text).
  const optinRaw       = firstNonEmpty(hs, values, n => n.includes('whatsapp notifications'));
  const whatsapp_optin = optinRaw ? 1 : 0;
  const optin_at       = whatsapp_optin ? submitted_at : null;
  const optin_version  = whatsapp_optin ? OPTIN_VERSION : null;

  const photo_consent = anyNonEmpty(hs, values, n => n.includes('photographed') || n.includes('social media')) ? 1 : 0;
  const tc_accepted   = anyNonEmpty(hs, values, n => n.includes('acceptance')) ? 1 : 0;

  // Children: linked name↔dob groups, branch-aware. Store the time-INVARIANT
  // capture (no age — age is computed on demand so it can never drift the hash).
  let cap;
  try { cap = extractChildren(hs, values); }
  catch { cap = { declared_count: null, children: [], needs_review: true }; }
  const children_json  = JSON.stringify(cap);
  const children_count = Array.isArray(cap.children) ? cap.children.length : 0;

  // needs_review triggers: no usable phone / children unparsed / no parent name.
  const noPhone        = !whatsapp_norm && !mobile_norm;
  const childrenReview = !!cap.needs_review;
  const noParentName   = !parent_first;
  const needs_review   = (noPhone || childrenReview || noParentName) ? 1 : 0;

  const reg = {
    submitted_at, parent_first, parent_last, email,
    mobile_norm, whatsapp_norm, children_json, children_count,
    whatsapp_optin, optin_at, optin_version,
    photo_consent, tc_accepted, qid, start_when, client_type, needs_review,
  };

  // Hash the canonical MAPPED fields (not the raw row / junk columns), so a junk
  // tail edit never changes the hash. submitted_at included → each submission is
  // distinct; re-reading an unchanged row yields the same hash (no duplicate).
  const canonical = JSON.stringify([
    submitted_at, parent_first, parent_last, email,
    mobile_norm, whatsapp_norm, children_json,
    whatsapp_optin, photo_consent, tc_accepted, qid, start_when, client_type,
  ]);
  reg.raw_row_hash = crypto.createHash('sha256').update(canonical).digest('hex');

  return reg;
}

module.exports = { mapRow, OPTIN_VERSION, normClientType };
