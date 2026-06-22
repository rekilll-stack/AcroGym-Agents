'use strict';

// Agent 3 — A.3 drip touch (2/3) content builder.
//
// Produces the WhatsApp message body for a due drip touch: a Claude-generated
// draft, falling back to the owner-approved verbatim text when Claude is
// unavailable (same pattern as the touch-1 welcome in index.js). This text goes
// to the ADMIN QUEUE as a draft — it is never auto-sent to the client. Injected
// into nurture.buildAndSendQueue via { buildContent } (default there stays the
// placeholder, so this real content only ships where lead-helper wires it).

const { generateText } = require('../../shared/claude');
const { createLogger }  = require('../../shared/logger');
const { buildDripPrompt, dripFallback } = require('./prompts');

const logger = createLogger('nurture');

/**
 * @param {object} candidate  drip candidate (from getDripCandidates)
 * @param {object} [deps]     { generate } — injectable for tests
 * @returns {Promise<string>} the draft message body
 */
async function buildDripContent(candidate, { generate = generateText } = {}) {
  const args = {
    touch:      candidate.next_touch,
    parentName: candidate.parent_name,
    ageSegment: candidate.age_segment,
  };
  let text = null;
  try {
    text = await generate(buildDripPrompt(args));
  } catch (err) {
    logger.warn({ err, touch: args.touch }, 'Claude unavailable — using verbatim drip fallback');
  }
  return text || dripFallback(args); // verbatim approved fallback
}

module.exports = { buildDripContent };
