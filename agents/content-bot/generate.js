'use strict';

// Content generation (C.2): Claude draft with a graceful, tagged fallback when
// Claude is unavailable (mirrors the lead-helper greeting / drip pattern).
// Returns a DRAFT string — never published anywhere by this code.

const { generateText } = require('../../shared/claude');
const { createLogger }  = require('../../shared/logger');
const { buildContentPrompt, fallbackContent, buildCaptionPrompt, fallbackCaption,
        buildHeadlinePrompt, parseHeadlines, fallbackHeadlines } = require('./prompts');

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

/**
 * Photo caption (C.4 vision): Claude Opus 4.8 looks at the image (base64) and
 * writes an English brand-voice caption, with the child-safety rules in the
 * prompt. Falls back to a tagged caption if vision is unavailable.
 * @param {object} p  { imageBase64, mediaType, context }
 * @param {object} [deps] { generate }
 */
async function generateCaption({ imageBase64, mediaType = 'image/jpeg', context = '' } = {}, { generate = generateText } = {}) {
  try {
    const prompt = buildCaptionPrompt(context);
    const text = await generate({ ...prompt, images: [{ data: imageBase64, media_type: mediaType }] });
    if (text && text.trim()) return text.trim();
    logger.warn('empty caption — using fallback');
  } catch (err) {
    logger.warn({ err: err.message }, 'Claude vision unavailable — using caption fallback');
  }
  return fallbackCaption();
}

/**
 * D.3 — generate 3 SHORT English image headlines for a theme (any language in).
 * Returns string[] (1-3). Falls back to brand-safe defaults if Claude is down.
 * 🔴 The owner PICKS one from these — nothing is auto-applied.
 * @param {string} topic
 * @param {object} [deps] { generate }
 * @returns {Promise<string[]>}
 */
async function generateHeadlines(topic, { generate = generateText } = {}) {
  try {
    const text = await generate(buildHeadlinePrompt(topic));
    const opts = parseHeadlines(text);
    if (opts.length) return opts;
    logger.warn('empty headline generation — using fallback');
  } catch (err) {
    logger.warn({ err: err.message }, 'Claude unavailable — using headline fallback');
  }
  return fallbackHeadlines();
}

module.exports = { generateContent, generateCaption, generateHeadlines };
