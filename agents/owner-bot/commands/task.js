'use strict';

/**
 * /task — «Задача»: owner types a task in free form, the dispatcher agent
 * decomposes it, does the safe part and reports back.
 *
 * Thin pipe by design: the BRAIN is ~/.claude/agents/acrogym-dispatcher.md
 * (the same brief the in-session dispatcher uses). Here we only ask for text,
 * run the headless CLI (subscription path — same shim the content-bot uses,
 * so no metered API), and post the reply. Gates live in the brief, not here.
 */

const fs   = require('fs');
const path = require('path');

const { createLogger }         = require('../../../shared/logger');
const { setState, clearState, getState } = require('../../../shared/state');
const { getPreferredLanguage } = require('../../../shared/preferences');
const { runCli }               = require('../../content-bot/agent');

const logger = createLogger('owner-bot');

const BRIEF_PATH = process.env.DISPATCHER_BRIEF
  || path.join(process.env.HOME || '/home/admin', '.claude/agents/acrogym-dispatcher.md');
// A dispatcher run fans out and reads a lot: give it more room than a designer
// run (30 turns / 5 min), but keep a hard ceiling so a runaway can't idle for
// hours. Owner-tunable via env.
const MAX_TURNS  = parseInt(process.env.DISPATCHER_MAX_TURNS  || '60', 10);
const TIMEOUT_MS = parseInt(process.env.DISPATCHER_TIMEOUT_MS || '900000', 10); // 15 min
const MODEL      = process.env.DISPATCHER_MODEL || 'opus';
const TG_LIMIT   = 3800;

const ASK = {
  ru: '🧠 *Задача диспетчеру*\n\nНапиши задачу одним сообщением — разложу на подзадачи, сделаю безопасную часть и отчитаюсь\\.\n\nОтмена: /menu',
  en: '🧠 *Task for the dispatcher*\n\nSend the task in one message — I will split it, do the safe part and report back\\.\n\nCancel: /menu',
};
const WAIT   = { ru: '🧠 Взял задачу. Разбираю и работаю…', en: '🧠 Got it. Working on the task…' };
const FAILED = { ru: '⚠️ Не смог выполнить задачу: ', en: '⚠️ Task failed: ' };
const EMPTY  = { ru: '⚠️ Диспетчер вернул пустой ответ.', en: '⚠️ Dispatcher returned an empty answer.' };

function readBrief() {
  const raw = fs.readFileSync(BRIEF_PATH, 'utf8');
  return raw.replace(/^---[\s\S]*?\n---\n/, ''); // drop the agent frontmatter
}

async function sendChunked(bot, chatId, text) {
  const body = String(text || '');
  for (let i = 0; i < body.length; i += TG_LIMIT) {
    await bot.sendMessage(chatId, body.slice(i, i + TG_LIMIT)).catch(() => {});
  }
}

/** Step 1: ask for the task text. */
module.exports = async function handleTask(msg, bot) {
  const chatId = msg.chat.id;
  const lang   = getPreferredLanguage(chatId) === 'ru' ? 'ru' : 'en';
  clearState(chatId);
  setState(chatId, 'task', 'await_text', {});
  await bot.sendMessage(chatId, ASK[lang], { parse_mode: 'MarkdownV2' }).catch(() => {});
};

/** Step 2: the owner's next plain message IS the task. */
module.exports.handleTaskText = async function handleTaskText(msg, bot) {
  const chatId = msg.chat.id;
  const lang   = getPreferredLanguage(chatId) === 'ru' ? 'ru' : 'en';
  const task   = (msg.text || '').trim();
  const st     = getState(chatId);
  if (!st || st.action !== 'task' || st.step !== 'await_text' || !task) return;

  clearState(chatId); // one task per invocation — a long run must not swallow the next message
  await bot.sendMessage(chatId, WAIT[lang]).catch(() => {});

  const prompt = `${readBrief()}\n\n---\n\nЗадача от владельца (пришла из Telegram, отвечай так, чтобы читалось с телефона):\n\n${task}`;
  logger.info({ chars: task.length }, 'dispatcher: task received');

  const run = await runCli(prompt, { model: MODEL, maxTurns: MAX_TURNS, timeoutMs: TIMEOUT_MS });
  if (!run.ok) {
    logger.error({ error: run.error, costUsd: run.costUsd }, 'dispatcher run failed');
    await bot.sendMessage(chatId, `${FAILED[lang]}${run.error}`).catch(() => {});
    return;
  }
  const answer = String(run.result || '').trim();
  logger.info({ costUsd: run.costUsd, turns: run.turns, chars: answer.length }, 'dispatcher run done');
  await sendChunked(bot, chatId, answer || EMPTY[lang]);
};
