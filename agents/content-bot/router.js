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

module.exports = { planFreeText, planFormatSelect };
