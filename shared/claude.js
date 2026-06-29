'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { createLogger } = require('./logger');

const logger = createLogger('claude');

let _client = null;

// Cost scopes — let a caller measure the total $ of all generateText calls it
// makes (e.g. one full carousel build), so the bot can show a correct per-post
// price. Per-process state (each bot is its own process).
const _costScopes = new Set();
function beginCost() { const s = { total: 0 }; _costScopes.add(s); return s; }
function endCost(s) { if (s) _costScopes.delete(s); return s ? s.total : 0; }

function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY не задан в .env');
  _client = new Anthropic({ apiKey });
  return _client;
}

const DEFAULT_MODEL      = 'claude-opus-4-8';
const DEFAULT_MAX_TOKENS = 1024;
const MAX_RETRIES        = 3;
const BASE_DELAY_MS      = 1000;

/**
 * Генерирует текст через Claude API с retry при rate limit.
 *
 * @param {object} params
 * @param {string} params.system      - системный промпт
 * @param {string} params.user        - пользовательский промпт
 * @param {number} [params.maxTokens] - макс. токены ответа
 * @param {string} [params.model]     - модель Claude
 * @returns {Promise<string>}         - текст ответа
 */
async function generateText({ system, user, images = null, maxTokens = DEFAULT_MAX_TOKENS, model = DEFAULT_MODEL }) {
  let lastError;

  // Vision: when images are supplied, the user turn becomes a content array of
  // image blocks (base64) followed by the text. Without images, content stays a
  // plain string (backward compatible). images = [{ data, media_type }].
  const content = Array.isArray(images) && images.length
    ? [
        ...images.map((im) => ({
          type: 'image',
          source: { type: 'base64', media_type: im.media_type || 'image/jpeg', data: im.data },
        })),
        { type: 'text', text: user },
      ]
    : user;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const client = getClient();

      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content }],
      });

      // Логируем приблизительную стоимость
      const input  = response.usage?.input_tokens  || 0;
      const output = response.usage?.output_tokens || 0;
      const costUSD = _estimateCost(model, input, output);
      for (const s of _costScopes) s.total += costUSD; // accrue into any open cost scopes
      logger.info({ model, input, output, costUSD: costUSD.toFixed(6) }, 'Claude API вызов');

      return response.content[0]?.text || '';

    } catch (err) {
      lastError = err;

      // Retry только при rate limit (429) или временных ошибках сервера (5xx)
      const status = err.status || err.statusCode;
      const isRetryable = status === 429 || (status >= 500 && status < 600);

      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1); // exponential backoff
        logger.warn({ attempt, delay, status }, `Claude rate limit / server error, retry через ${delay}ms`);
        await _sleep(delay);
        continue;
      }

      break;
    }
  }

  logger.error({ err: lastError }, 'Claude API не ответил после всех попыток');
  throw lastError;
}

// Приблизительные цены ($/1M tokens) по состоянию на 2026
function _estimateCost(model, inputTokens, outputTokens) {
  const pricing = {
    'claude-sonnet-4-5': { input: 3.0, output: 15.0 },
    'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
    'claude-opus-4-8':   { input: 15.0, output: 75.0 }, // opus tier (approx); for cost-log estimate
    'claude-opus-4-7':   { input: 15.0, output: 75.0 },
    'claude-haiku-4-5':  { input: 0.25, output: 1.25 },
    'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  };
  const p = pricing[model] || pricing['claude-sonnet-4-5'];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { generateText, beginCost, endCost };
