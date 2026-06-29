'use strict';

/**
 * Autonomous competitor / market analysis (Agent 4 — "super SMM" loop).
 *
 * 🔴 COST DESIGN (owner's call): the market analysis runs through the HEADLESS
 * `claude -p` agent (agent.runCli), which bills against the claude.ai
 * SUBSCRIPTION (no ANTHROPIC_API_KEY in the child env) — NOT the metered API.
 * So deep web research every few days is cheap and does not burn the bot's API
 * budget. The bot's own Opus/Sonnet API is reserved for copy + verify only.
 *
 * Output: the agent returns plain text with two delimited sections — we write
 *   - data/competitor-brief.md   (strategic, read by the plan strategist)
 *   - data/reports/competitor-YYYY-MM-DD.md   (owner-facing report, sent to TG)
 * Using delimiters (not JSON) keeps large markdown robust — no escaping issues.
 */

const fs = require('fs');
const path = require('path');
const agent = require('./agent');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('content-bot');

const BRIEF_PATH = path.join(__dirname, '../../data/competitor-brief.md');
const REPORTS_DIR = path.join(__dirname, '../../data/reports');

// Smarter model for strategy (still on the subscription via the CLI). Override
// with CONTENT_RESEARCH_MODEL. Sonnet = good analysis/cost balance.
const RESEARCH_MODEL = process.env.CONTENT_RESEARCH_MODEL || 'opus';
const RESEARCH_MAX_TURNS = parseInt(process.env.CONTENT_RESEARCH_MAX_TURNS || '60', 10);
const RESEARCH_TIMEOUT_MS = parseInt(process.env.CONTENT_RESEARCH_TIMEOUT_MS || '900000', 10); // 15 min

// The Qatar competitive set (Doha kids' gymnastics / acro). Extend as needed.
const COMPETITORS = [
  '@mygymqatar (MyGym Qatar)',
  '@rebelangelsqatar (Rebel Angels Sports)',
  '@gymacademy_doha (The Gymnastics Academy)',
  '@gymnasticsqatar (Olympic Stars)',
  'Doha Sport & Arts (Master Rami Al Banna)',
];

function todayStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TIMEZONE || 'Asia/Qatar', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function buildPrompt(lang = 'ru') {
  let prev = '';
  try { prev = fs.readFileSync(BRIEF_PATH, 'utf8'); } catch { /* first run */ }
  const reportLang = lang === 'en' ? 'English' : 'Russian';
  return [
    'You are AcroGym Qatar\'s personal SENIOR social-media strategist. AcroGym is a kids\' gymnastics & acrobatics club in Doha with a new gym at Lagoona Mall; audience = parents of children 3-14; brand voice = warm, energetic, safe, professional.',
    'TASK: run a fresh, deep competitive & market analysis for Instagram, then output an updated strategy brief AND an owner report.',
    '',
    'Use WEB SEARCH / web fetch to research these Qatar competitors (current followers, posting cadence, dominant content themes & formats — Reels vs carousels vs photos, tone, what seems to drive engagement, any campaigns/offers):',
    ...COMPETITORS.map((c) => `  - ${c}`),
    'Also glance at AcroGym\'s own page @acrogymqatar if visible. Factor the Qatar season/school calendar (e.g. summer heat → indoor activity demand) and current Instagram trends relevant to a kids\' activity brand.',
    '',
    'If Metricool tools are available, you MAY pull follower/engagement numbers for the brand or any configured competitors — but do NOT block on it; web research is the primary source.',
    '',
    'Then produce TWO things, separated EXACTLY by the delimiter lines shown (no other use of "===" in your output):',
    '',
    '===BRIEF===',
    '(A concise STRATEGY BRIEF in Markdown that REPLACES the existing brief — the content planner reads this as context. Keep the structure: market landscape table, what rivals over-do, AcroGym\'s differentiation/opportunities, content pillars, voice & visual guardrails. Keep it truthful — no invented prices/dates/names. ~400-600 words.)',
    '',
    '===REPORT===',
    `(An OWNER-FACING report written ENTIRELY in ${reportLang}, Markdown, SCANNABLE and under ~450 words. Sections (translate the headings into ${reportLang}): "What competitors are doing now" (key numbers/observations, 1 line per competitor), "What works / trends", "Recommendation for the coming cycle" (3-5 concrete steps: which posts/stories/formats), "What to avoid". Speak to the owner directly, like his trusted SMM lead.)`,
    '',
    'Output ONLY those two delimited sections. Begin now.',
    prev ? `\n(Previous brief for reference — improve on it, note what changed:)\n${prev}` : '',
  ].filter(Boolean).join('\n');
}

function splitSections(text) {
  const s = String(text || '');
  const briefM = s.match(/===BRIEF===\s*([\s\S]*?)\s*===REPORT===/);
  const reportM = s.match(/===REPORT===\s*([\s\S]*)$/);
  const brief = briefM ? briefM[1].trim() : '';
  const report = reportM ? reportM[1].trim() : '';
  return { brief, report };
}

/**
 * Run the analysis via the headless agent and persist outputs.
 * @returns {Promise<{ok, reportMd?, briefUpdated?, reportPath?, costUsd, error?}>}
 */
async function runAnalysis({ lang = 'ru' } = {}) {
  logger.info({ model: RESEARCH_MODEL, lang }, 'competitor analysis: starting headless research');
  const run = await agent.runCli(buildPrompt(lang), {
    model: RESEARCH_MODEL, maxTurns: RESEARCH_MAX_TURNS, timeoutMs: RESEARCH_TIMEOUT_MS,
  });
  if (!run.ok) {
    logger.error({ error: run.error, costUsd: run.costUsd }, 'competitor analysis failed');
    return { ok: false, error: run.error || 'agent error', costUsd: run.costUsd || 0 };
  }
  const { brief, report } = splitSections(run.result);
  if (!report) {
    logger.error({ resultPreview: String(run.result).slice(0, 300) }, 'competitor analysis: no report section');
    return { ok: false, error: 'no report in agent output', costUsd: run.costUsd || 0 };
  }

  // Persist the brief (planner context) — only if the agent returned one.
  let briefUpdated = false;
  if (brief && brief.length > 200) {
    try { fs.writeFileSync(BRIEF_PATH, brief + '\n', 'utf8'); briefUpdated = true; }
    catch (err) { logger.warn({ err: err.message }, 'could not write competitor brief'); }
  }

  // Persist a dated owner report.
  let reportPath = null;
  try {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    reportPath = path.join(REPORTS_DIR, `competitor-${todayStr()}.md`);
    fs.writeFileSync(reportPath, report + '\n', 'utf8');
  } catch (err) { logger.warn({ err: err.message }, 'could not write report file'); }

  logger.info({ costUsd: run.costUsd, turns: run.turns, briefUpdated, reportPath }, 'competitor analysis done');
  return { ok: true, reportMd: report, briefUpdated, reportPath, costUsd: run.costUsd || 0 };
}

module.exports = { runAnalysis, COMPETITORS, BRIEF_PATH, REPORTS_DIR };
