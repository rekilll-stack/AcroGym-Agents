'use strict';

// Ядро ответа: черновик → редактор → страж запрещённых слов.
// Используется ботом (index.js) и тестами (scripts/test-answer-bot.js) —
// одна логика, никакого дрейфа между продом и проверками.

const { generateText } = require('../content-bot/llm');
const { buildAnswerPrompt, buildReviewPrompt } = require('./prompts');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('answer-bot');

/**
 * @param {string} question
 * @param {Array}  [history]
 * @param {Array}  [images]  [{media_type, data(base64)}]
 * @returns {Promise<string>} финальный ответ
 */
async function answer(question, history = [], images = null) {
  const prompt = buildAnswerPrompt(question, history);
  const draft = (await generateText(images ? { ...prompt, images } : prompt) || '').trim();
  if (!draft) throw new Error('пустой ответ LLM');

  let out = draft;
  try {
    const review = (await generateText(buildReviewPrompt(question, draft)) || '').trim();
    if (review && review !== 'OK' && !/^OK\b/.test(review)) out = review;
  } catch (e) { logger.warn({ e: e.message }, 'review pass failed — отправляю черновик'); }

  // Жёсткий страж: запрещённые слова не пройдут даже мимо редактора.
  if (/\b(trial|free)\b/i.test(out.split('———')[0])) {
    logger.warn('banned word slipped — форсирую переписывание');
    try {
      const fix = (await generateText(buildReviewPrompt(
        question + '\n(REMINDER: the words trial/free are strictly banned)', out)) || '').trim();
      if (fix && fix !== 'OK' && !/^OK\b/.test(fix)) out = fix;
    } catch (_) { /* оставляем как есть — лучше с словом, чем без ответа */ }
  }
  return out;
}

module.exports = { answer };
