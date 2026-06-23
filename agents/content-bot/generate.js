'use strict';

// Content generation (C.2): Claude draft with a graceful, tagged fallback when
// Claude is unavailable (mirrors the lead-helper greeting / drip pattern).
// Returns a DRAFT string — never published anywhere by this code.

const { generateText } = require('../../shared/claude');
const { createLogger }  = require('../../shared/logger');
const { buildContentPrompt, fallbackContent } = require('./prompts');

const logger = createLogger('content-bot');

/**
 * @param {'post'|'ideas'|'plan'} format
 * @param {string} topic
 * @param {object} [deps]  { generate } — injectable for tests
 * @returns {Promise<string>}
 */
async function generateContent(format, topic, { generate = generateText } = {}) {
  try {
    const text = await generate(buildContentPrompt(format, topic));
    if (text && text.trim()) return text.trim();
    logger.warn({ format }, 'empty generation — using fallback');
  } catch (err) {
    logger.warn({ err: err.message, format }, 'Claude unavailable — using content fallback');
  }
  return fallbackContent(format, topic);
}

module.exports = { generateContent };
