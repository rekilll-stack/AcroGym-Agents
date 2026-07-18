'use strict';
// Контент-студия — оркестрация обсуждения. Ограниченный по раундам прогон:
// модератор ставит бриф → роли высказываются по очереди → модератор сводит
// финальное предложение. Всё на Sonnet 5. Источник LLM инжектируется.

const { PERSONAS, ORDER } = require('./personas');
const { createLogger } = require('../../shared/logger');
const logger = createLogger('content-studio');

const MODEL = 'claude-sonnet-5'; // по решению владельца — все переговоры на Sonnet 5

function renderTranscript(transcript) {
  if (!transcript.length) return '(обсуждение только начинается)';
  return transcript.map((t) => `${t.emoji} ${t.name}: ${t.text}`).join('\n\n');
}

// Запас под thinking Sonnet 5 + полноценную реплику (на 800 критика обрезало).
async function speak(persona, { topic, transcript, task, generate, maxTokens = 1100 }) {
  const user =
    `Тема от владельца: «${topic}».\n\n` +
    `Обсуждение команды до этого момента:\n${renderTranscript(transcript)}\n\n` +
    `Твоя задача сейчас: ${task}`;
  const text = await generate({ system: persona.system, user, model: MODEL, maxTokens });
  return String(text || '').trim();
}

const ROLE_TASKS = {
  smm:   'Дай угол подачи и цель поста, формат (Reel/карусель/фото) и почему — коротко.',
  photo: 'Предложи конкретные кадры/визуал под тему (2-3 кадра: сюжет, эмоция, композиция).',
  copy:  'Предложи цепляющий крючок и короткий черновик подписи (можно RU/EN).',
  critic:'Разбери предложенное: 2-3 замечания и что улучшить ДО публикации.',
  audience:'Дай реакцию 3 родителей на предложенный пост (зашло/не зашло и почему), от их лица.',
};

/**
 * @param {object} p { topic, deps:{generate} }
 * @returns {Promise<{transcript:Array, proposal:string}>}
 */
async function runSession({ topic, deps = {} }) {
  // По умолчанию — ПОДПИСОЧНЫЙ путь (шим content-bot/llm через headless `claude -p`,
  // Sonnet, $0 API), как решил владелец. Тесты инжектируют свой generate.
  const generate = deps.generate || require('../content-bot/llm').generateText;
  const onTurn = deps.onTurn; // опц. коллбэк(persona, text) — постить реплику вживую по мере генерации
  const transcript = [];
  const post = async (persona, text) => {
    transcript.push({ key: persona.key, name: persona.name, emoji: persona.emoji, text });
    if (onTurn) { try { await onTurn(persona, text); } catch (e) { logger.error({ e: e.message }, 'onTurn failed'); } }
  };

  logger.info({ topic }, 'studio session start');

  // 1. Модератор — бриф
  await post(PERSONAS.moderator, await speak(PERSONAS.moderator, {
    topic, transcript, generate, maxTokens: 500,
    task: 'Открой обсуждение: кратко сформулируй бриф по теме (1 цель + 1-2 вопроса команде). Идею сам не предлагай.',
  }));

  // 2. Роли по очереди (каждый видит предыдущих)
  for (const key of ORDER) {
    await post(PERSONAS[key], await speak(PERSONAS[key], {
      topic, transcript, generate, task: ROLE_TASKS[key],
    }));
  }

  // 3. Модератор — финальное предложение владельцу
  const proposal = await speak(PERSONAS.moderator, {
    topic, transcript, generate, maxTokens: 900,
    task:
      'Сведи мнения команды в ОДНО финальное предложение поста: формат · тема/угол · какие кадры · ' +
      'черновик подписи (крючок + суть + призыв). Последней строкой: «На утверждение: ✅ делаем / ↩️ переделать».',
  });
  await post(PERSONAS.moderator, proposal);

  logger.info({ topic, turns: transcript.length }, 'studio session done');
  return { transcript, proposal };
}

module.exports = { runSession, renderTranscript };
