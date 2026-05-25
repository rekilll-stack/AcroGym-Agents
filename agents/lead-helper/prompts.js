'use strict';

const SYSTEM_PROMPT =
  'You are the assistant of AcroGym, a children\'s gymnastics center opening September 2026 ' +
  'in The Pearl, Qatar. Write a warm, short welcome WhatsApp message to a parent who just ' +
  'submitted an inquiry. Tone: friendly, professional, not dry. Length: 3-5 sentences. ' +
  'Use emojis sparingly (1-2 per message). Do NOT mention specific prices, schedules, or ' +
  'address — we don\'t know these yet. Goal: confirm receipt of inquiry, indicate we\'ll ' +
  'contact within an hour, build excitement. Sign with: \'AcroGym Team 🤸\'.';

/**
 * Builds Claude prompt for welcome message generation.
 *
 * @param {object} params
 * @param {string} params.parentName
 * @returns {{ system: string, user: string, maxTokens: number, model: string }}
 */
function buildGreetingPrompt({ parentName }) {
  return {
    system: SYSTEM_PROMPT,
    user: `Write a welcome message for a parent named ${parentName || 'there'}.`,
    maxTokens: 400,
    model: 'claude-sonnet-4-5',
  };
}

module.exports = { buildGreetingPrompt };
