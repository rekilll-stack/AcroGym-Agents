'use strict';
// Контент-студия — оркестрация обсуждения. Ограниченный по раундам прогон:
// модератор ставит бриф → роли высказываются по очереди → модератор сводит
// финальное предложение. Всё на Opus 5. Источник LLM инжектируется.

const { PERSONAS, ORDER } = require('./personas');
const { createLogger } = require('../../shared/logger');
const logger = createLogger('content-studio');

const MODEL = 'claude-opus-5'; // по решению владельца — все переговоры на Opus 5

function renderTranscript(transcript) {
  if (!transcript.length) return '(обсуждение только начинается)';
  return transcript.map((t) => `${t.emoji} ${t.name}: ${t.text}`).join('\n\n');
}

// Запас под thinking Sonnet 5 + полноценную реплику (на 800 критика обрезало).
async function speak(persona, { topic, transcript, task, generate, maxTokens = 1100, discussName = 'русском' }) {
  const user =
    `Тема от владельца: «${topic}».\n\n` +
    `Обсуждение команды до этого момента:\n${renderTranscript(transcript)}\n\n` +
    `Твоя задача сейчас: ${task}\n\n` +
    `Веди ОБСУЖДЕНИЕ на ${discussName} языке. (Сам пост/подпись — всегда на английском.)`;
  // Устойчивость: один сбой/пустой ответ шима не должен ронять ВСЮ сессию —
  // ретрай, и запасная реплика, чтобы дискуссия дошла до синтеза и личного итога.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const text = String(await generate({ system: persona.system, user, model: MODEL, maxTokens }) || '').trim();
      if (text) return text;
    } catch (e) {
      logger.warn({ e: e.message, persona: persona.name, attempt }, 'speak failed — retry/fallback');
    }
  }
  return '(пропускаю — не удалось получить реплику)';
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
  // Opus, $0 API), как решил владелец. Тесты инжектируют свой generate.
  const generate = deps.generate || require('../content-bot/llm').generateText;
  const onTurn = deps.onTurn; // опц. коллбэк(persona, text) — постить реплику вживую по мере генерации
  const roles = (deps.roles && deps.roles.length) ? deps.roles : ORDER; // какие роли участвуют (у кого есть бот)
  const lang = deps.lang === 'en' ? 'en' : 'ru';        // язык ОБСУЖДЕНИЯ команды (пост ВСЕГДА на английском)
  const discussName = lang === 'en' ? 'английском' : 'русском';
  const mode = deps.mode === 'weekly' ? 'weekly' : 'post'; // 'weekly' = планёрка недели, 'post' = обсуждение поста
  const WEEKLY_TASKS = {
    smm: 'Фокус недели и 3-4 темы постов — что и зачем.',
    photo: 'Какие кадры/визуал нужны под темы недели.',
    copy: 'Какие сообщения и крючки в постах недели, какой тон.',
    critic: 'Что на этой неделе избегать — риски, клише, повторы.',
    audience: 'Что родителям сейчас важно и интересно (реакция 3 родителей).',
  };
  const transcript = [];
  const post = async (persona, text) => {
    transcript.push({ key: persona.key, name: persona.name, emoji: persona.emoji, text });
    if (onTurn) { try { await onTurn(persona, text); } catch (e) { logger.error({ e: e.message }, 'onTurn failed'); } }
  };

  logger.info({ topic }, 'studio session start');

  // 1. Модератор — бриф
  await post(PERSONAS.moderator, await speak(PERSONAS.moderator, {
    topic, transcript, generate, maxTokens: 500, discussName,
    task: mode === 'weekly'
      ? 'Открой планёрку на неделю: 1 цель недели + 1-2 вопроса команде. План сам не диктуй.'
      : 'Открой обсуждение: кратко сформулируй бриф по теме (1 цель + 1-2 вопроса команде). Идею сам не предлагай.',
  }));

  // 2. Обсуждение НЕСКОЛЬКИМИ кругами — пока команда не сойдётся во мнении (или до предела кругов).
  const MAX_ROUNDS = Math.max(1, parseInt(process.env.STUDIO_DISCUSS_ROUNDS || '3', 10));
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    for (const key of roles) {
      const base = mode === 'weekly'
        ? WEEKLY_TASKS[key]
        : (key === 'copy'
          ? `${ROLE_TASKS.copy} ВАЖНО: сам ПОСТ (подпись) — ВСЕГДА на английском, независимо от языка обсуждения.`
          : ROLE_TASKS[key]);
      const task = round === 1 ? base
        : `${base} Это круг ${round}: ответь на мнения коллег выше — с чем согласен, с чем нет — и двигай команду к ЕДИНОМУ решению. Не повторяй уже сказанное.`;
      await post(PERSONAS[key], await speak(PERSONAS[key], { topic, transcript, generate, task, discussName }));
    }
    if (round >= MAX_ROUNDS) break;               // последний круг — сразу к синтезу
    if (round < 2) {                              // минимум 2 круга: после первого ВСЕГДА идём на второй
      await post(PERSONAS.moderator, 'Первый круг собран — обсудим спорное ещё круг.');
      continue;
    }
    // Со 2-го круга — проверка согласия; при согласии обрываем, иначе ещё круг (до MAX_ROUNDS=3).
    const check = await speak(PERSONAS.moderator, {
      topic, transcript, generate, maxTokens: 220, discussName,
      task: 'Команда сошлась в ЕДИНОМ мнении или ещё спорит? Ответь СТРОГО первым словом ДА или НЕТ, затем одно короткое предложение.',
    });
    const consensus = /^\s*да\b/i.test(check);
    await post(PERSONAS.moderator, consensus
      ? 'Похоже, договорились — свожу итог. ✅'
      : 'Ещё есть разногласия — даю команде ещё круг.');
    if (consensus) break;
  }

  // 3. Модератор — финальное предложение владельцу
  const proposal = await speak(PERSONAS.moderator, {
    topic, transcript, generate, maxTokens: 900, discussName,
    task: mode === 'weekly'
      ? 'Сведи обсуждение в ПЛАН НА НЕДЕЛЮ: фокус недели + список постов (тема · формат · день) + 1-2 инсайта по конкурентам. Коротко и по делу.'
      : 'Сведи мнения команды в ОДНО финальное предложение поста: формат · тема/угол · какие кадры · ' +
        'черновик подписи (крючок + суть + призыв) — ПОДПИСЬ ВСЕГДА НА АНГЛИЙСКОМ ЯЗЫКЕ. ' +
        'Последней строкой: «На утверждение: ✅ делаем / ↩️ переделать».',
  });
  await post(PERSONAS.moderator, proposal);

  logger.info({ topic, turns: transcript.length }, 'studio session done');
  return { transcript, proposal };
}

module.exports = { runSession, renderTranscript };
