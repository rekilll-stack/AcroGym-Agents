'use strict';

// Pure routing decisions for the content-bot (testable without Telegram).
// Two natural flows:
//   A) pick a format → bot asks for a topic → user types it → generate.
//   B) user types what they want FIRST → it's remembered as a pending topic →
//      picking a format generates with it immediately (never drop their text).

const { isFormat } = require('./prompts');

/** Decide what a free-text message means given the current session. */
function planFreeText(session, text) {
  const s = session || {};
  const t = (text || '').trim();
  if (s.awaiting === 'topic' && isFormat(s.format) && t) {
    return { action: 'generate', format: s.format, topic: t };   // flow A: awaited topic
  }
  if (t) {
    return { action: 'store', topic: t };                        // flow B: remember as pending
  }
  return { action: 'noop' };
}

/** Decide what tapping a format button means given the current session. */
function planFormatSelect(session, format) {
  if (!isFormat(format)) return { action: 'ignore' };
  const s = session || {};
  if (s.pendingTopic) {
    return { action: 'generate', format, topic: s.pendingTopic }; // flow B: use remembered topic
  }
  return { action: 'ask', format };                               // flow A: ask for the topic
}

// Telegram CopyTextButton.text max is 256 chars; keep a margin for multibyte
// (emoji count as 2 UTF-16 units) so the API never rejects the whole keyboard.
const COPY_TEXT_LIMIT = 250;

/**
 * Build the Copy button. Short drafts get a NATIVE copy_text button (the
 * Telegram client copies the text straight to the clipboard on tap — Bot API
 * 7.11+; passed as raw JSON, the 0.66 wrapper forwards it untouched). Long
 * drafts (> limit) fall back to a callback that re-sends the clean text as a
 * standalone message (long-press → Copy).
 */
function buildCopyButton(label, draft) {
  if (typeof draft === 'string' && draft.length > 0 && draft.length <= COPY_TEXT_LIMIT) {
    return { text: label, copy_text: { text: draft } };
  }
  return { text: label, callback_data: 'copy' };
}

/**
 * Escape text for an HTML <pre> code block. Telegram renders <pre> with a
 * native one-tap COPY icon (works for any length — unlike copy_text's 256 cap),
 * and copies the DECODED text, so the clipboard gets the clean original.
 */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { planFreeText, planFormatSelect, buildCopyButton, COPY_TEXT_LIMIT, escapeHtml };
