'use strict';

/**
 * Broadcast preview/dry-run formatter (B3) — PURE, no IO, no sending.
 * Renders MarkdownV2 text from a resolved audience. Dynamic values go through
 * escapeMd() (static i18n strings are pre-escaped in the catalogs). The full
 * number never appears — only phone_masked from the resolver.
 *
 * Language comes from the caller (owner's global preference). The MESSAGE BODY
 * the owner typed is untranslated free text; only this chrome is localised.
 */

const { t }        = require('../../../shared/i18n');
const { escapeMd } = require('../../../shared/telegram');

const SAMPLE = 5; // preview shows the first N; dry-run shows all.

// dob → age (mirrors shared/db _regAge / nurture; kept local to the UI layer).
function _ageFromDob(dobRaw) {
  if (!dobRaw) return null;
  const d = new Date(String(dobRaw).trim());
  if (isNaN(d)) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const md = now.getUTCMonth() - d.getUTCMonth();
  if (md < 0 || (md === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

/** "Name (age)" for children whose age falls in [min,max]; '' if none/parse fail. */
function childrenInBand(childrenJson, min, max) {
  let kids = [];
  try { kids = JSON.parse(childrenJson).children || []; } catch { return ''; }
  return kids
    .map(c => ({ name: c.first_name || '', age: _ageFromDob(c.dob) }))
    .filter(c => c.age != null && c.age >= min && c.age <= max)
    .map(c => `${c.name} (${c.age})`)
    .join(', ');
}

// Localised client-type word, reusing the button labels (emoji stripped) so we
// don't add new keys: 'new' → New/Новые, 'existing' → Existing/Существующие.
function ctypeWord(value, lang) {
  const key = value === 'new' ? 'broadcast.btn_ctype_new'
            : value === 'existing' ? 'broadcast.btn_ctype_existing'
            : null;
  if (!key) return value || '';
  return t(key, lang).split(/\s+/).slice(1).join(' '); // drop the leading emoji
}

/** Human, localised, MarkdownV2-safe label for the segment. */
function segmentLabel(segment, lang) {
  const k = segment.kind;
  if (k === 'age')         return escapeMd(t('broadcast.seg_age_label', lang, { band: `${segment.min}–${segment.max}` }));
  if (k === 'client_type') return escapeMd(t('broadcast.seg_ctype_label', lang, { value: ctypeWord(segment.value, lang) }));
  return escapeMd(t('broadcast.seg_all_label', lang));
}

/** One recipient line: "• Name — 974•••••22 [— child (age)]". All escaped. */
function recipientLine(r, segment, lang) {
  let line = `• ${escapeMd(r.display_name)} — ${escapeMd(r.phone_masked)}`;
  if (segment.kind === 'age' && r.children_json) {
    const kids = childrenInBand(r.children_json, segment.min, segment.max);
    if (kids) line += ` — ${escapeMd(kids)}`;
  }
  return line;
}

/**
 * Preview: the typed message + meta (channel/segment/N) + first few recipients.
 * @param {{ text, channel, segment, lang, recipients }} a
 */
function buildPreview({ text, channel, segment, lang = 'en', recipients }) {
  const meta = t('broadcast.preview_meta', lang, {
    channel: escapeMd(t(`broadcast.channel_${channel}`, lang)),
    segment: segmentLabel(segment, lang),
    count:   escapeMd(String(recipients.length)),
  });

  const head = `${t('broadcast.preview_title', lang)}\n\n${escapeMd(text)}\n\n${meta}`;

  if (recipients.length === 0) {
    return `${head}\n\n${t('broadcast.empty_audience', lang)}`;
  }
  const sample = recipients.slice(0, SAMPLE).map(r => recipientLine(r, segment, lang)).join('\n');
  return `${head}\n\n${t('broadcast.preview_sample_header', lang)}\n${sample}`;
}

/**
 * Dry-run: the FULL recipient list (masked), no truncation, no sending.
 * @param {{ segment, lang, recipients }} a
 */
function buildDryRun({ segment, lang = 'en', recipients }) {
  const title = t('broadcast.dryrun_title', lang, { count: escapeMd(String(recipients.length)) });
  if (recipients.length === 0) return `${title}\n\n${t('broadcast.empty_audience', lang)}`;
  const lines = recipients.map(r => recipientLine(r, segment, lang)).join('\n');
  return `${title}\n${lines}`;
}

module.exports = { buildPreview, buildDryRun, childrenInBand, segmentLabel, SAMPLE };
