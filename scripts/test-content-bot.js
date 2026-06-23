'use strict';

/**
 * C.2 — content-bot prompts + generation (no Telegram, no DB).
 *   node scripts/test-content-bot.js
 */

const { isFormat, formatLabel, buildContentPrompt, fallbackContent } = require('../agents/content-bot/prompts');
const { generateContent } = require('../agents/content-bot/generate');
const { planFreeText, planFormatSelect } = require('../agents/content-bot/router');

let pass = 0, fail = 0;
const T = (n, c) => { console.log((c ? '  ✅ ' : '  ❌ ') + n); c ? pass++ : fail++; };

(async () => {
  console.log('=== format helpers ===');
  T('post/ideas/plan are formats', isFormat('post') && isFormat('ideas') && isFormat('plan'));
  T('photo_soon / junk are NOT formats', !isFormat('photo_soon') && !isFormat('nope'));
  T('labels', formatLabel('post') === 'Full post' && formatLabel('plan') === 'Week plan');

  console.log('\n=== prompts: brand voice + topic woven in ===');
  for (const f of ['post', 'ideas', 'plan']) {
    const p = buildContentPrompt(f, 'first gymnastics class');
    T(`${f}: brand context (AcroGym/Doha/Kristina)`, /AcroGym/.test(p.system) && /Doha/.test(p.system) && /Kristina/.test(p.system));
    T(`${f}: slogan in voice`, /grow through movement, confidence, and joy/.test(p.system));
    T(`${f}: avoids cheap urgency (guardrail present)`, /Hurry! Sign up now/.test(p.system) && /AVOID/.test(p.system));
    T(`${f}: no-invent-facts guard`, /Never invent facts/.test(p.system) && /September 2026/.test(p.system));
    T(`${f}: topic carried into user msg`, /first gymnastics class/.test(p.user));
    T(`${f}: model + token budget`, p.model === 'claude-sonnet-4-5' && p.maxTokens >= 500);
  }
  // post-specific: hashtag instruction present
  T('post: asks for 8-15 hashtags from pool', /8-15 relevant hashtags/.test(buildContentPrompt('post','x').system) && /#AcroGym/.test(buildContentPrompt('post','x').system));
  T('ideas: asks 5-7 ideas', /5-7 Instagram post IDEAS/.test(buildContentPrompt('ideas','x').system));
  T('plan: one-week 5-7 posts', /ONE-WEEK/.test(buildContentPrompt('plan','x').system));
  T('empty topic → safe default, no crash', /AcroGym/.test(buildContentPrompt('post','').user));
  T('unknown format → throws', (() => { try { buildContentPrompt('bogus','x'); return false; } catch { return true; } })());

  console.log('\n=== fallbacks: tagged offline, topic present, post has hashtags ===');
  for (const f of ['post', 'ideas', 'plan']) {
    const fb = fallbackContent(f, 'meet our coach');
    T(`${f}: tagged offline skeleton`, /offline skeleton/.test(fb));
  }
  T('post fallback carries hashtags', /#AcroGym/.test(fallbackContent('post','x')));
  T('ideas fallback is a numbered list', /1\./.test(fallbackContent('ideas','x')) && /5\./.test(fallbackContent('ideas','x')));
  T('plan fallback covers the week (Mon..Sun)', /Mon —/.test(fallbackContent('plan','x')) && /Sun —/.test(fallbackContent('plan','x')));

  console.log('\n=== generateContent: model OK → uses text; throw/empty → fallback ===');
  const ok = await generateContent('post', 'topic', { generate: async () => 'A WARM POLISHED POST ✨' });
  T('model text used', ok === 'A WARM POLISHED POST ✨');
  const down = await generateContent('ideas', 'topic', { generate: async () => { throw new Error('429'); } });
  T('Claude down → fallback (tagged)', /offline skeleton/.test(down));
  const empty = await generateContent('plan', 'topic', { generate: async () => '   ' });
  T('empty generation → fallback (tagged)', /offline skeleton/.test(empty));
  T('result always trimmed string', typeof ok === 'string' && ok === ok.trim());

  console.log('\n=== router flow A: pick format → ask → type topic → generate ===');
  // After picking a format (no pending topic) → ask for the topic.
  T('format select, no pending → ask', planFormatSelect({}, 'post').action === 'ask');
  // Awaiting topic + user types it → generate with that topic.
  let r = planFreeText({ format: 'post', awaiting: 'topic' }, 'summer open day');
  T('awaited topic → generate with the typed topic', r.action === 'generate' && r.format === 'post' && r.topic === 'summer open day');

  console.log('\n=== router flow B (the bug): type topic FIRST → remembered → format uses it ===');
  // No format chosen yet, user types what they want → store it, don't drop it.
  r = planFreeText({}, 'announce registration opens next week');
  T('text before format → stored as pending (NOT dropped)', r.action === 'store' && r.topic === 'announce registration opens next week');
  // Then they tap a format → generate using the remembered topic (the fix).
  r = planFormatSelect({ pendingTopic: 'announce registration opens next week' }, 'post');
  T('format with pending topic → generate WITH that topic (bug fixed)', r.action === 'generate' && r.topic === 'announce registration opens next week');

  console.log('\n=== router edge cases ===');
  T('empty text → noop (no spurious store)', planFreeText({}, '   ').action === 'noop');
  T('bad format → ignore', planFormatSelect({ pendingTopic: 'x' }, 'bogus').action === 'ignore');
  T('awaiting topic wins over pending (flow A precedence)',
    planFreeText({ format: 'ideas', awaiting: 'topic', pendingTopic: 'old' }, 'new topic').topic === 'new topic');

  console.log('\n🔴 boundary: no Instagram-publish CODE in the bot (word "Instagram" in boundary comments is fine)');
  const fs2 = require('fs'); const p2 = require('path');
  const idx = fs2.readFileSync(p2.join(__dirname, '../agents/content-bot/index.js'), 'utf8');
  const gen = fs2.readFileSync(p2.join(__dirname, '../agents/content-bot/generate.js'), 'utf8');
  const both = idx + '\n' + gen;
  // Real IG-publish primitives / generic outbound HTTP clients — none should exist.
  T('no Graph API / IG publish primitives', !/graph\.facebook|media_publish|creation_id|instagram_business_account|ig_user/i.test(both));
  T('no generic outbound HTTP client (only Telegram transport)', !/require\(['"](axios|node-fetch|got|undici)['"]\)|https?\.request\(/.test(both));

  console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.stack); process.exit(1); });
