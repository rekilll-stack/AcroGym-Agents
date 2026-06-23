'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { createLogger } = require('./logger');

const logger = createLogger('claude');

let _client = null;

function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY не задан в .env');
  _client = new Anthropic({ apiKey });
  return _client;
}

const DEFAULT_MODEL      = 'claude-sonnet-4-5';
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
async function generateText({ system, user, maxTokens = DEFAULT_MAX_TOKENS, model = DEFAULT_MODEL }) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const client = getClient();

      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      });

      // Логируем приблизительную стоимость
      const input  = response.usage?.input_tokens  || 0;
      const output = response.usage?.output_tokens || 0;
      const costUSD = _estimateCost(model, input, output);
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
    'claude-opus-4-8':   { input: 15.0, output: 75.0 }, // opus tier (approx); for cost-log estimate
    'claude-opus-4-7':   { input: 15.0, output: 75.0 },
    'claude-haiku-4-5':  { input: 0.25, output: 1.25 },
  };
  const p = pricing[model] || pricing['claude-sonnet-4-5'];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { generateText };
