'use strict';

/**
 * Content plan — on-demand weekly plan that the bot then FOLLOWS (Agent 4).
 *
 * Owner-driven flow (no auto-generation):
 *   1) Owner asks for a plan (📅 button) → bot proposes N posts (theme + type).
 *   2) Owner reviews: edit any line ("2: new theme"), regenerate, or approve.
 *   3) On approval → themes are mapped onto the next scheduled weekdays and saved
 *      to data/content-plan.json (survives restarts), status='planned'.
 *   4) A daily cron builds the post for each day's theme and sends it as an
 *      APPROVAL CARD (routine=false). Nothing reaches Instagram without the
 *      owner's tap — the plan only decides WHAT/WHEN to assemble, never publishes.
 *
 * The pending (un-approved) draft plan lives in memory per chat; the approved
 * plan is the only thing persisted.
 */

const fs = require('fs');
const path = require('path');
const { generateText } = require('../../shared/claude');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('content-bot');

const TZ = process.env.TIMEZONE || 'Asia/Qatar';
const PLAN_PATH = path.join(__dirname, '../../data/content-plan.json');
const BRIEF_PATH = path.join(__dirname, '../../data/competitor-brief.md');

// The strategist model. Opus = the sharpest planner; plan generation is on-demand
// and infrequent (~2 calls/request), so the extra cost is negligible.
const STRATEGIST_MODEL = process.env.CONTENT_PLAN_MODEL || 'claude-opus-4-8';

function loadBrief() {
  try { return fs.readFileSync(BRIEF_PATH, 'utf8'); } catch { return ''; }
}

// A short human label for "now" so the strategist can factor season/timing.
function seasonContext() {
  const now = new Date();
  const month = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'long' }).format(now);
  return `Current month: ${month} (Qatar). Factor local season, school calendar and weather (summer = hot, families seek indoor activities).`;
}

// Default cadence: 5 posts/week, Mon–Fri (JS weekday: Sun=0 … Sat=6). Bumped
// from 3/wk per the competitor analysis (rivals post 4–5×/wk; 2–3/mo = invisible).
const DEFAULT_DAYS = [1, 2, 3, 4, 5];
const DEFAULT_COUNT = 5;

// ── persistence ───────────────────────────────────────────────────
function load() {
  try { return JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8')); }
  catch { return { updatedAt: null, days: DEFAULT_DAYS, items: [] }; }
}

function save(plan) {
  plan.updatedAt = new Date().toISOString();
  fs.writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 2), 'utf8');
  return plan;
}

// ── dates ─────────────────────────────────────────────────────────
// YYYY-MM-DD for a Date in the brand timezone.
function ymd(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}
function todayYmd() { return ymd(new Date()); }

// JS weekday (0–6) of a Date in the brand timezone.
function weekdayInTz(date) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(date);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(s);
}

// The next `count` calendar dates (from TOMORROW) that fall on `days` weekdays.
function nextSlots(count, days = DEFAULT_DAYS) {
  const out = [];
  const d = new Date();
  for (let i = 1; i <= 60 && out.length < count; i++) {
    const probe = new Date(d.getTime() + i * 24 * 3600 * 1000);
    if (days.includes(weekdayInTz(probe))) out.push(ymd(probe));
  }
  return out;
}

// ── pending (un-approved) draft plans, per chat ───────────────────
const pending = new Map(); // chatId → { items:[{theme,type}], days }

function rid() { return Math.random().toString(16).slice(2, 8); }

// ── generation (2-stage: analyse → propose) ───────────────────────
// Stage 1 — a senior SMM strategist studies the competitor brief, brand and
// season, and produces a compact strategy (NOT the posts yet). This is what
// makes the plan considered rather than generic.
const ANALYST_SYSTEM = `You are a SENIOR social-media strategist — AcroGym Qatar's personal SMM lead. AcroGym is a kids' gymnastics & acrobatics club in Doha with a new gym at Lagoona Mall. Audience: parents of children 3–14.
You are given a COMPETITOR & POSITIONING BRIEF for the Qatar market. Study it deeply and think like a strategist, not a copywriter.
Produce a SHORT, sharp strategy for the next batch of posts:
- the differentiated angle vs the named Qatar competitors,
- which content pillars to hit this batch and why,
- 1–2 audience-engagement hooks worth leaning on now (questions, saves, shares),
- anything to AVOID (what rivals over-do).
Keep it under ~180 words, plain text, no fluff. This guides the post proposals next.`;

// Stage 2 — turn the strategy into concrete, buildable post proposals.
const PROPOSE_SYSTEM = `You are AcroGym Qatar's SMM lead turning an agreed STRATEGY into a content plan of exactly N Instagram carousel posts. Audience: parents of children 3–14. Voice: warm, energetic, safe, professional.
Each post = a concrete, buildable TOPIC (a specific angle, not a vague category) + a TYPE tag + a one-line HOOK + a short WHY (how it serves the strategy / engages the audience).
Ensure VARIETY and a coherent, beautiful feed (rotate pillars: emotional, trust/safety, benefits/education, behind-the-scenes, proof, announcement/seasonal).
🔴 Do NOT invent specifics the club hasn't given you: no made-up coach/staff names, no specific children, no fabricated testimonials, quotes, prices, dates, discounts or results. Keep topics GENERAL and truthful — e.g. "Meet our coaches" not "Meet Coach Sarah".
Return STRICT JSON ONLY, no prose:
{"posts":[{"theme":"<specific topic, ENGLISH, one line>","type":"<one lowercase tag>","hook":"<one-line scroll-stopper>","why":"<short reason, ENGLISH>"}, ... exactly N items]}`;

async function analyse(focus = '') {
  const brief = loadBrief();
  return generateText({
    system: ANALYST_SYSTEM,
    model: STRATEGIST_MODEL,
    user: `COMPETITOR & POSITIONING BRIEF:\n${brief || '(no brief on file — reason from general best practice for a kids\' acro club in Doha)'}\n\n${seasonContext()}\n${focus ? `Owner's focus for this batch: ${focus}` : 'No specific focus — plan a balanced, engaging batch.'}\n\nGive the strategy.`,
    maxTokens: 500,
  });
}

async function generateDraft(chatId, { count = DEFAULT_COUNT, days = DEFAULT_DAYS, focus = '' } = {}) {
  // Stage 1: strategy from deep competitor/brand analysis.
  let strategy = '';
  try { strategy = await analyse(focus); } catch (err) { logger.warn({ err: err.message }, 'plan analysis failed → proposing without strategy'); }

  // Stage 2: concrete proposals grounded in the strategy.
  const raw = await generateText({
    system: PROPOSE_SYSTEM,
    model: STRATEGIST_MODEL,
    user: `STRATEGY:\n${strategy || '(none — use best practice)'}\n\nN: ${count}\nReturn the JSON.`,
    maxTokens: 900,
  });
  let parsed;
  try { const m = String(raw).match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.posts) || !parsed.posts.length) {
    throw new Error('plan generation: unparseable');
  }
  const items = parsed.posts.slice(0, count).map((p) => ({
    theme: String(p.theme || '').trim(),
    type: String(p.type || 'post').trim().toLowerCase(),
    hook: String(p.hook || '').trim(),
    why: String(p.why || '').trim(),
  })).filter((p) => p.theme);
  if (!items.length) throw new Error('plan generation: empty');
  pending.set(String(chatId), { items, days, strategy });
  return items;
}

function getPending(chatId) { return pending.get(String(chatId)); }
function clearPending(chatId) { pending.delete(String(chatId)); }

// Edit one line of the pending plan (1-based). Returns updated items or null.
function editPendingLine(chatId, n, theme) {
  const p = pending.get(String(chatId));
  if (!p || n < 1 || n > p.items.length) return null;
  p.items[n - 1].theme = theme.trim();
  return p.items;
}

// ── approve: map pending onto dates and persist ───────────────────
function approve(chatId) {
  const p = pending.get(String(chatId));
  if (!p || !p.items.length) return null;
  const slots = nextSlots(p.items.length, p.days || DEFAULT_DAYS);
  const items = p.items.map((it, i) => ({
    id: rid(),
    date: slots[i] || null,
    theme: it.theme,
    type: it.type,
    status: 'planned',
  }));
  clearPending(chatId);
  return save({ updatedAt: null, days: p.days || DEFAULT_DAYS, items });
}

// ── execution helpers (used by the daily cron) ────────────────────
// Items scheduled for today that haven't been built yet.
function dueToday() {
  const today = todayYmd();
  return load().items.filter((it) => it.date === today && it.status === 'planned');
}

// The next not-yet-built item (soonest date), regardless of day — for "build next now".
function nextPlanned() {
  const items = load().items
    .filter((it) => it.status === 'planned' && it.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  return items[0] || null;
}

function setStatus(id, status) {
  const plan = load();
  const it = plan.items.find((x) => x.id === id);
  if (!it) return false;
  it.status = status;
  save(plan);
  return true;
}

function skipLine(n) {
  const plan = load();
  const it = plan.items[n - 1];
  if (!it) return false;
  it.status = 'skipped';
  save(plan);
  return true;
}

function replaceLine(n, theme) {
  const plan = load();
  const it = plan.items[n - 1];
  if (!it) return false;
  it.theme = theme.trim();
  if (it.status === 'built' || it.status === 'published') it.status = 'planned';
  save(plan);
  return true;
}

// ── rendering ─────────────────────────────────────────────────────
const STATUS_ICON = { planned: '🕒', built: '🛠', published: '✅', skipped: '⏭' };
const WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

function dayLabel(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T12:00:00Z`);
  return `${WD[weekdayInTz(d)]} ${dateStr.slice(8, 10)}.${dateStr.slice(5, 7)}`;
}

// Numbered list of the PENDING draft (no dates yet — owner is still reviewing).
// Shows the WHY under each topic so the owner sees the strategist's reasoning.
function renderPending(items) {
  return items.map((it, i) => {
    const why = it.why ? `\n   ↳ ${it.why}` : '';
    return `${i + 1}. ${it.theme} [${it.type}]${why}`;
  }).join('\n');
}

// Numbered list of the APPROVED plan (with dates + statuses).
function renderPlan(plan) {
  if (!plan.items.length) return 'План пуст.';
  return plan.items.map((it, i) =>
    `${i + 1}. ${STATUS_ICON[it.status] || ''} ${dayLabel(it.date)} — ${it.theme} [${it.type}]`).join('\n');
}

module.exports = {
  PLAN_PATH, DEFAULT_DAYS, DEFAULT_COUNT,
  load, save, ymd, todayYmd, nextSlots,
  generateDraft, getPending, clearPending, editPendingLine, approve,
  dueToday, nextPlanned, setStatus, skipLine, replaceLine,
  renderPending, renderPlan, dayLabel,
};
