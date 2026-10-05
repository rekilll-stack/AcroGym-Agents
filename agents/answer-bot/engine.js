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
async function answer(question, history = [], images = null, noteLang = 'ru') {
  const prompt = buildAnswerPrompt(question, history, noteLang);
  const draft = (await generateText(images ? { ...prompt, images } : prompt) || '').trim();
  if (!draft) throw new Error('пустой ответ LLM');

  let out = draft;
  try {
    const review = (await generateText(buildReviewPrompt(question, draft, noteLang)) || '').trim();
    if (review && review !== 'OK' && !/^OK\b/.test(review)) out = review;
  } catch (e) { logger.warn({ e: e.message }, 'review pass failed — отправляю черновик'); }

  // Жёсткий страж: запрещённые слова не пройдут даже мимо редактора.
  if (/\b(trial|free)\b/i.test(out.split('———')[0])) {
    logger.warn('banned word slipped — форсирую переписывание');
    try {
      const fix = (await generateText(buildReviewPrompt(
        question + '\n(REMINDER: the words trial/free are strictly banned)', out, noteLang)) || '').trim();
      if (fix && fix !== 'OK' && !/^OK\b/.test(fix)) out = fix;
    } catch (_) { /* оставляем как есть — лучше с словом, чем без ответа */ }
  }
  return out;
}

// ── Глубокий режим (владелец 05.10: «на нестандартные вопросы бот должен иметь
// доступ сюда и получать красивый и полноценный ответ»). Тот же Claude, но с
// памятью клуба (memory-MCP, только чтение) и документами из docs/. Песочница:
// права default (без bypass), cwd = docs/ — Read/Grep/Glob видят только его,
// из MCP подключён один сервер памяти и разрешён один инструмент — recall.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCli } = require('../content-bot/agent');

const DOCS = path.join(__dirname, '../../docs');
let _mcpCfg = null;
function memoryMcpConfig() { // берём запись сервера памяти из конфига Claude Code — секреты в репо не копируем
  if (_mcpCfg) return _mcpCfg;
  const mem = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).mcpServers.memory;
  _mcpCfg = path.join(os.tmpdir(), 'answer-bot-mcp.json');
  fs.writeFileSync(_mcpCfg, JSON.stringify({ mcpServers: { memory: mem } }), { mode: 0o600 });
  return _mcpCfg;
}

const RESEARCH = `
DEEP MODE — the knowledge base above does not fully answer this question. Research first, then answer:
1) mcp__memory__memory_recall — 2-4 short keyword queries in Russian AND English (e.g. «парковка», «parking») for club facts and the owner's decisions. Ignore records marked «УСТАРЕЛА» / outdated; the newer record wins.
2) Club documents in the current folder (Grep/Glob/Read): AcroGym-Admin-Operations-Guide.pdf, AcroGym-Price-List.pdf (the ONLY current price list — files starting with "archive-" are OUTDATED, never use them), coaches/ (coach regulations).
Rules: prices, discounts and plan rules come ONLY from the knowledge base above, never from memory or files. Use a researched fact only when it is clearly a confirmed club fact or owner decision; if sources conflict or nothing confirms it, keep "let me check" for that part and in the note list exactly what to ask Kirill. Never reveal internal data (other clients, finances, staff pay, credentials).
Then write a complete, warm, well-structured reply in the usual format: the client text, then ——— and the note for the admin. In the note, name the source of each new fact in a few words (e.g. «память: решение владельца 05.10»).`;

async function deepAnswer(question, history = [], noteLang = 'ru') {
  const p = buildAnswerPrompt(question, history, noteLang);
  const run = await runCli(`${p.system}\n\n${p.user}\n${RESEARCH}`, {
    maxTurns: 14, timeoutMs: 240000, permissionMode: 'default', cwd: DOCS,
    extraArgs: ['--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--mcp-config', memoryMcpConfig(),
      '--allowedTools', 'mcp__memory__memory_recall'],
  });
  const out = String((run.ok && run.result) || '').trim();
  if (!out) throw new Error('deep: ' + (run.error || 'пустой ответ'));
  logger.info({ costUsd: run.costUsd, turns: run.turns }, 'deep answer');
  if (/\btrial\b|\bfree (first |trial )?(class|session|lesson)/i.test(out.split('———')[0])) throw new Error('deep: запрещённое слово'); // «free parking» можно, «free class» — нет
  return out;
}

module.exports = { answer, deepAnswer };
