'use strict';

/**
 * LLM shim for the content bot — drop-in for `{ generateText, beginCost, endCost }`
 * from shared/claude, but routes through the HEADLESS `claude -p` agent so it runs
 * on the claude.ai SUBSCRIPTION (no metered Anthropic API charges).
 *
 * 🔴 Owner's call (2026-06-29): everything the bot does should run on the $100
 * subscription he already pays — zero extra API billing. The headless agent
 * (agent.runCli) strips ANTHROPIC_API_KEY so it uses the logged-in claude.ai
 * account. Trade-off the owner accepted: each call is a CLI spawn (slower) and
 * draws on the shared Max quota.
 *
 * Mode switch: CONTENT_LLM_MODE=subscription (default) | api. In `api` mode it
 * delegates straight to shared/claude (the old metered path) as an escape hatch.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const agent = require('./agent');
const shared = require('../../shared/claude');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('content-bot');

const MODE = (process.env.CONTENT_LLM_MODE || 'subscription').toLowerCase();

// Cost scopes (mirror shared/claude) so callers' beginCost/endCost keep working.
// In subscription mode these accrue the CLI's reported subscription $.
const _scopes = new Set();
function beginCost() {
  if (MODE !== 'subscription') return shared.beginCost();
  const s = { total: 0 }; _scopes.add(s); return s;
}
function endCost(s) {
  if (MODE !== 'subscription') return shared.endCost(s);
  if (s) _scopes.delete(s);
  return s ? s.total : 0;
}

// Owner's call (2026-06-29): run EVERYTHING on Opus 4.8 for max quality. We force
// the opus alias for all calls regardless of the per-module model arg. Override
// with CONTENT_CLI_MODEL if a cheaper/faster model is ever needed.
const FORCE_MODEL = process.env.CONTENT_CLI_MODEL || 'opus';
function cliModel(/* model */) {
  return FORCE_MODEL;
}

async function generateTextSub({ system, user, images = null, model }) {
  let prompt = (system ? `${system}\n\n` : '') + (user || '');
  const tmp = [];
  let dir = null;
  if (Array.isArray(images) && images.length) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-'));
    images.forEach((im, i) => {
      const ext = String(im.media_type || 'image/jpeg').includes('png') ? 'png' : 'jpg';
      const fp = path.join(dir, `img${i}.${ext}`);
      fs.writeFileSync(fp, Buffer.from(im.data, 'base64'));
      tmp.push(fp);
    });
    prompt += `\n\nIMAGES TO ANALYZE — read EACH with the Read tool before answering:\n${tmp.map((p) => `- ${p}`).join('\n')}`;
  }
  prompt += '\n\nIMPORTANT: output ONLY the requested answer/JSON — no preamble, no commentary, no markdown code fences.';

  const hasImg = !!tmp.length;
  const run = await agent.runCli(prompt, {
    model: cliModel(model),
    maxTurns: hasImg ? 8 : 4,
    timeoutMs: hasImg ? 180000 : 120000,
  });
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  if (!run.ok) throw new Error(`llm(subscription): ${run.error}`);
  for (const s of _scopes) s.total += (run.costUsd || 0);
  logger.info({ model: cliModel(model), vision: hasImg, costUsd: run.costUsd, turns: run.turns }, 'llm subscription call');
  return run.result || '';
}

async function generateText(opts) {
  if (MODE !== 'subscription') return shared.generateText(opts);
  return generateTextSub(opts);
}

module.exports = { generateText, beginCost, endCost, MODE };
