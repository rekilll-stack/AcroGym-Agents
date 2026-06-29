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

// Default cadence: 3 posts/week on Mon/Wed/Fri (JS weekday: Sun=0 … Sat=6).
const DEFAULT_DAYS = [1, 3, 5];
const DEFAULT_COUNT = 3;

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

// ── generation ────────────────────────────────────────────────────
const GEN_SYSTEM = `You plan Instagram content for AcroGym Qatar — a kids' gymnastics & acrobatics club in Doha. Audience: parents of children 3–14. Voice: warm, energetic, safe, professional.
Propose a content plan of exactly N posts for the coming period. Each post = a concrete carousel TOPIC (a specific angle the bot can build, not a vague category) + a content TYPE tag.
Ensure VARIETY across the plan (mix types: educational, emotional, behind-the-scenes, benefits, meet-the-coach, social-proof, seasonal/announcement).
🔴 Do NOT invent specifics the club hasn't given you: no made-up coach/staff names, no specific children, no fabricated testimonials, quotes, prices, dates, discounts or results. Keep each topic GENERAL and truthful — something any AcroGym post could honestly cover (the club fills in real names/details later). E.g. "Meet our coaches" not "Meet Coach Sarah"; "A parent's first-cartwheel story" not a specific invented child.
Return STRICT JSON ONLY, no prose:
{"posts":[{"theme":"<specific post topic in ENGLISH, one line>","type":"<one lowercase tag>"}, ... exactly N items]}`;

async function generateDraft(chatId, { count = DEFAULT_COUNT, days = DEFAULT_DAYS, focus = '' } = {}) {
  const raw = await generateText({
    system: GEN_SYSTEM,
    user: `N: ${count}\n${focus ? `Focus / theme for this batch: ${focus}` : 'No specific focus — a balanced week.'}\nReturn the JSON.`,
    maxTokens: 700,
  });
  let parsed;
  try { const m = String(raw).match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.posts) || !parsed.posts.length) {
    throw new Error('plan generation: unparseable');
  }
  const items = parsed.posts.slice(0, count).map((p) => ({
    theme: String(p.theme || '').trim(),
    type: String(p.type || 'post').trim().toLowerCase(),
  })).filter((p) => p.theme);
  if (!items.length) throw new Error('plan generation: empty');
  pending.set(String(chatId), { items, days });
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
function renderPending(items) {
  return items.map((it, i) => `${i + 1}. ${it.theme} [${it.type}]`).join('\n');
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
