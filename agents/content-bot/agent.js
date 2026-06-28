'use strict';

/**
 * Headless "designer agent" runner (Agent 4 — autonomous posting, Pro path).
 *
 * WHY: Canva's public REST API can't edit designs on the Pro plan (no
 * duplicate / update_fill / autofill — autofill is Enterprise-only). The flow
 * that DOES work on Pro is the Canva MCP connector (mcp.canva.com). The `claude`
 * CLI on this server is logged into the owner's account and has the Canva +
 * Metricool + Yandex MCPs connected, so we delegate the mechanical Canva editing
 * to a headless `claude -p` run.
 *
 * COST CONTROL (owner-set):
 *   - model defaults to Haiku (cheap; the work is mechanical, copy is written
 *     separately by Opus on the bot side — the agent only PLACES given strings).
 *   - hard turn cap (--max-turns) + wall-clock timeout bound runaway loops.
 *   - per-run cost is read from the CLI's total_cost_usd and checked against
 *     MAX_POST_COST_USD ($0.50 default); over-budget runs are flagged so the
 *     caller can alert and stop auto-publishing.
 *
 * 🔴 The agent only ASSEMBLES visuals. Publishing stays in publish.js behind the
 *    approval gate — we do NOT let the agent post on its own.
 */

const { execFile } = require('child_process');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('content-bot');

const CLI = process.env.CLAUDE_CLI || `${process.env.HOME || '/home/admin'}/.npm-global/bin/claude`;
const MODEL = process.env.CONTENT_DESIGNER_MODEL || 'haiku';
const MAX_TURNS = parseInt(process.env.CONTENT_DESIGNER_MAX_TURNS || '30', 10);
const TIMEOUT_MS = parseInt(process.env.CONTENT_DESIGNER_TIMEOUT_MS || '300000', 10); // 5 min
const MAX_COST_USD = parseFloat(process.env.MAX_POST_COST_USD || '0.5');

function runCli(prompt, { model = MODEL, maxTurns = MAX_TURNS, timeoutMs = TIMEOUT_MS } = {}) {
  const args = [
    '-p', prompt,
    '--model', model,
    '--max-turns', String(maxTurns),
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'json',
  ];
  // 🔴 Strip ANTHROPIC_API_KEY from the child env: with an API key present the
  // CLI runs in API-key mode where the claude.ai CONNECTORS (Canva/Metricool)
  // are NOT available. Without it, the CLI uses the logged-in claude.ai account
  // (the existing subscription) which HAS the connectors. (Diagnosed live.)
  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_AUTH_TOKEN;

  return new Promise((resolve) => {
    execFile(CLI, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: childEnv }, (err, stdout, stderr) => {
      if (err && !stdout) {
        return resolve({ ok: false, error: `cli: ${err.message}`, costUsd: 0, raw: (stderr || '').slice(0, 500) });
      }
      let outer;
      try { outer = JSON.parse(stdout); } catch { return resolve({ ok: false, error: 'cli: unparseable output', costUsd: 0, raw: String(stdout).slice(0, 800) }); }
      resolve({
        ok: outer.is_error !== true,
        result: outer.result || '',
        costUsd: outer.total_cost_usd || 0,
        turns: outer.num_turns,
        raw: outer,
      });
    });
  });
}

function parseStrictJson(text) {
  try { const m = String(text).match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

/**
 * Build a carousel by delegating Canva editing to the headless agent.
 *
 * @param {object} p
 * @param {string} p.templateDesignId  brand carousel template to copy (cover + inner pages)
 * @param {Array<object>} p.slides
 *    each: { page:Number, assetId:String, headline:String, body?:String, cta?:String }
 *    page 1 = cover (headline + cta), pages 2..n = inner (headline word + body).
 * @returns {Promise<{ok, slides?:Array<{page,url}>, designId?, costUsd, overBudget, error?}>}
 */
async function buildCarousel({ templateDesignId, slides }) {
  const pages = slides.map((s) => s.page);
  const spec = slides.map((s) => ({
    page: s.page,
    asset_id: s.assetId,
    headline: s.headline,
    ...(s.body != null ? { body: s.body } : {}),
    ...(s.cta != null ? { cta: s.cta } : {}),
  }));

  const prompt = [
    'You are a Canva production assistant. Use ONLY the Canva tools. Do NOT invent or rephrase any text — place the EXACT strings given.',
    '',
    'Steps:',
    `1. Copy the design ${templateDesignId} to a new design (copy-design).`,
    '2. Start an editing transaction on the NEW design.',
    '3. For EACH item below, on its page: set the full-bleed BACKGROUND photo to the given asset_id using update_fill on that page\'s main background image element, then replace the headline text (and body / cta text if given) with the EXACT strings provided. Keep layer order — only swap fills and text, never move elements.',
    '4. Commit the transaction.',
    `5. Export pages ${JSON.stringify(pages)} of the new design as PNG (export-design), width 1080 height 1350.`,
    '6. Reply with STRICT JSON ONLY, no prose:',
    '   {"designId":"<new id>","slides":[{"page":<n>,"url":"<export url>"}, ...]}',
    '',
    'Items:',
    JSON.stringify(spec, null, 2),
  ].join('\n');

  logger.info({ templateDesignId, slides: slides.length, model: MODEL }, 'designer agent: building carousel');
  const run = await runCli(prompt);
  const overBudget = run.costUsd > MAX_COST_USD;
  if (!run.ok) {
    logger.error({ error: run.error, costUsd: run.costUsd }, 'designer agent failed');
    return { ok: false, error: run.error || 'agent error', costUsd: run.costUsd, overBudget };
  }
  const parsed = parseStrictJson(run.result);
  if (!parsed || !Array.isArray(parsed.slides) || !parsed.slides.length) {
    logger.error({ resultPreview: String(run.result).slice(0, 300) }, 'designer agent: no slides in result');
    return { ok: false, error: 'agent returned no slides', costUsd: run.costUsd, overBudget };
  }
  logger.info({ designId: parsed.designId, slides: parsed.slides.length, costUsd: run.costUsd, turns: run.turns, overBudget }, 'designer agent done');
  return { ok: true, designId: parsed.designId, slides: parsed.slides, costUsd: run.costUsd, turns: run.turns, overBudget };
}

// Local datetime string (no offset) in the brand timezone, for Metricool.
function localDateTime(when = new Date(), tz = process.env.TIMEZONE || 'Asia/Qatar') {
  const d = new Date(when.toLocaleString('en-US', { timeZone: tz }));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Is the headless publish path usable? (CLI present → Metricool connector path.)
function canPublish() {
  try { return require('fs').existsSync(CLI); } catch { return true; }
}

/**
 * Publish ONE Instagram post via the Metricool MCP connector (no REST token /
 * paid API needed). The BOT decides when to call this (after the approval gate);
 * the agent only executes.
 * @param {object} p
 * @param {string[]} p.media        PUBLIC media URLs in slide order
 * @param {string}   p.caption      verbatim caption
 * @param {string[]} [p.altTexts]
 * @param {'POST'|'STORY'|'REEL'} [p.igType]
 * @param {Date}     [p.when]       schedule time (default ~now+2min)
 * @param {boolean}  [p.bestTime]   ask Metricool for the best upcoming slot
 * @param {boolean}  [p.autoPublish]
 * @returns {Promise<{ok, postId?, error?, costUsd, overBudget}>}
 */
async function publishPost({ media, caption, altTexts = [], igType = 'POST', when = new Date(Date.now() + 2 * 60000), bestTime = false, autoPublish = true }) {
  const blogId = process.env.METRICOOL_BLOG_ID || '6469959';
  const tz = process.env.TIMEZONE || 'Asia/Qatar';
  const dt = localDateTime(when, tz);
  const prompt = [
    'You are a Metricool publishing assistant. Use ONLY the Metricool tools. Do NOT alter the caption text.',
    'Create ONE Instagram post with EXACTLY these values:',
    `- blogId: ${blogId}`,
    `- network/provider: instagram; instagramData type: ${igType}`,
    bestTime
      ? `- timing: first call the Metricool best-time tool for instagram on this blog, pick the soonest high-value upcoming slot, and schedule at it (timezone ${tz}). If unavailable, use ${dt} ${tz}.`
      : `- publicationDate: ${dt} timezone ${tz}`,
    `- autoPublish: ${autoPublish}; draft: false`,
    `- media (this exact order): ${JSON.stringify(media)}`,
    altTexts.length ? `- mediaAltText: ${JSON.stringify(altTexts)}` : '',
    '- text (caption, VERBATIM, between the markers):',
    '<<<CAPTION',
    String(caption || ''),
    'CAPTION>>>',
    '',
    'After it is created, reply with STRICT JSON ONLY: {"ok":true,"postId":"<id>"} or {"ok":false,"error":"<why>"}.',
  ].filter(Boolean).join('\n');

  logger.info({ igType, media: (media || []).length, bestTime, model: MODEL }, 'designer agent: publishing via Metricool MCP');
  const run = await runCli(prompt);
  const overBudget = run.costUsd > MAX_COST_USD;
  if (!run.ok) return { ok: false, error: run.error || 'agent error', costUsd: run.costUsd, overBudget };
  const parsed = parseStrictJson(run.result) || {};
  if (parsed.ok !== true) return { ok: false, error: parsed.error || 'agent did not confirm publish', costUsd: run.costUsd, overBudget };
  logger.info({ postId: parsed.postId, costUsd: run.costUsd, turns: run.turns }, 'designer agent: published');
  return { ok: true, postId: parsed.postId, costUsd: run.costUsd, overBudget, turns: run.turns };
}

module.exports = { buildCarousel, publishPost, canPublish, runCli, localDateTime, MODEL, MAX_COST_USD };
