'use strict';

/**
 * C.2 — content-bot prompts + generation (no Telegram, no DB).
 *   node scripts/test-content-bot.js
 */

const { isFormat, formatLabel, buildContentPrompt, fallbackContent, buildCaptionPrompt, fallbackCaption } = require('../agents/content-bot/prompts');
const { generateContent, generateCaption } = require('../agents/content-bot/generate');
const { planFreeText, planFormatSelect, buildCopyButton, COPY_TEXT_LIMIT, escapeHtml } = require('../agents/content-bot/router');

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
    T(`${f}: model + token budget`, p.model === 'claude-opus-4-8' && p.maxTokens >= 500);
  }
  // post-specific: hashtag instruction present
  T('post: asks for 8-15 hashtags from pool', /8-15 relevant hashtags/.test(buildContentPrompt('post','x').system) && /#AcroGym/.test(buildContentPrompt('post','x').system));
  T('ideas: asks 5-7 ideas', /5-7 Instagram post IDEAS/.test(buildContentPrompt('ideas','x').system));
  T('plan: one-week 5-7 posts', /ONE-WEEK/.test(buildContentPrompt('plan','x').system));
  T('empty topic → safe default, no crash', /AcroGym/.test(buildContentPrompt('post','').user));
  T('unknown format → throws', (() => { try { buildContentPrompt('bogus','x'); return false; } catch { return true; } })());

  console.log('\n=== 3-level language: RU input → EN output directive + i18n keys ===');
  const { t } = require('../shared/i18n');
  // Output directive present in BOTH system and user message.
  const ruPrompt = buildContentPrompt('post', 'пост про первое занятие');
  T('system: input-may-be-Russian → always English', /written in Russian/.test(ruPrompt.system) && /write the output in English/i.test(ruPrompt.system));
  T('user: explicit ENGLISH-regardless directive', /ENTIRELY IN ENGLISH regardless/i.test(ruPrompt.user));
  T('user: Russian topic carried verbatim', /пост про первое занятие/.test(ruPrompt.user));
  // i18n content.* keys exist and differ across RU/EN (interface is switchable).
  const keys = ['menu_prompt', 'btn_post', 'btn_ideas', 'btn_plan', 'ask_topic', 'btn_copy', 'btn_regen', 'btn_menu', 'lang_prompt', 'access_denied'];
  let allEn = true, allRu = true, allDiffer = true;
  for (const k of keys) {
    const en = t(`content.${k}`, 'en'), ru = t(`content.${k}`, 'ru');
    if (!en || en === `content.${k}`) allEn = false;
    if (!ru || ru === `content.${k}`) allRu = false;
    if (en === ru) allDiffer = false;
  }
  T('content.* keys present in EN', allEn);
  T('content.* keys present in RU', allRu);
  T('EN and RU interface strings differ (truly localized)', allDiffer);
  T('format labels localized (post: EN≠RU)', t('content.label_post', 'en') !== t('content.label_post', 'ru'));

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

  console.log('\n=== copy-to-clipboard: short → native copy_text, long → fallback callback ===');
  const short = 'A short caption for AcroGym 🤸';
  const longDraft = 'x'.repeat(COPY_TEXT_LIMIT + 1);
  const bShort = buildCopyButton('📋 Copy', short);
  const bLong  = buildCopyButton('📋 Copy', longDraft);
  T('short draft → native copy_text button with exact text', bShort.copy_text && bShort.copy_text.text === short && !bShort.callback_data);
  T('copy_text payload is the clean draft (no markers)', bShort.copy_text.text === short);
  T('long draft → callback fallback (no copy_text)', bLong.callback_data === 'copy' && !bLong.copy_text);
  T(`boundary at limit: <=${COPY_TEXT_LIMIT} native, >limit fallback`,
    !!buildCopyButton('c', 'y'.repeat(COPY_TEXT_LIMIT)).copy_text && !buildCopyButton('c', 'y'.repeat(COPY_TEXT_LIMIT + 1)).copy_text);
  T('empty/undefined draft → fallback (no broken copy_text)', !buildCopyButton('c', '').copy_text && !buildCopyButton('c').copy_text);
  T('button always carries a label', bShort.text === '📋 Copy' && bLong.text === '📋 Copy');

  console.log('\n=== C.4 photo caption: vision prompt + 🔴 CHILD SAFETY + fallback ===');
  const cap = buildCaptionPrompt('сняли на первом занятии');
  T('caption: brand block (AcroGym/Doha/Kristina)', /AcroGym/.test(cap.system) && /Doha/.test(cap.system) && /Kristina/.test(cap.system));
  T('caption: Opus 4.8 vision model', cap.model === 'claude-opus-4-8');
  // 🔴 the safety control — the prompt must forbid describing children
  T('🔴 child-safety: forbids appearance/body/face/clothing', /physical appearance, body, face, clothing/i.test(cap.system));
  T('🔴 child-safety: no names', /Do NOT use or invent names/i.test(cap.system));
  T('🔴 child-safety: no age estimates', /Do NOT estimate ages/i.test(cap.system));
  T('🔴 child-safety: about ACTIVITY not individual children', /about the ACTIVITY/i.test(cap.system) && /NOT about individual children/i.test(cap.system));
  T('🔴 child-safety: marked strict/non-negotiable', /STRICT, NON-NEGOTIABLE/i.test(cap.system));
  T('caption: English-only even with Russian context', /English only/i.test(cap.system) && /write the caption in\s*English/i.test(cap.system));
  T('caption: Russian context carried for the model', /сняли на первом занятии/.test(cap.user));
  T('caption fallback: tagged offline + hashtags', /offline skeleton/.test(fallbackCaption()) && /#AcroGym/.test(fallbackCaption()));
  // generateCaption: passes the image to the model; falls back on failure
  let capturedImages = null;
  const okCap = await generateCaption({ imageBase64: 'AAAA', mediaType: 'image/jpeg', context: 'x' },
    { generate: async (p) => { capturedImages = p.images; return 'A WARM CAPTION 🤸'; } });
  T('generateCaption: model text used', okCap === 'A WARM CAPTION 🤸');
  T('generateCaption: image passed as base64 block to the model', Array.isArray(capturedImages) && capturedImages[0].data === 'AAAA' && capturedImages[0].media_type === 'image/jpeg');
  const downCap = await generateCaption({ imageBase64: 'AAAA' }, { generate: async () => { throw new Error('vision down'); } });
  T('generateCaption: vision down → tagged fallback', /offline skeleton/.test(downCap));

  console.log('\n=== <pre> code-block copy: escapeHtml for any-length one-tap copy ===');
  T('escapes & < > for valid <pre>', escapeHtml('a & b < c > d') === 'a &amp; b &lt; c &gt; d');
  T('leaves hashtags / emoji / apostrophes intact (clean clipboard)', escapeHtml("#AcroGym 🤸 it's") === "#AcroGym 🤸 it's");
  T('a full-length post survives escaping (no length cap, unlike copy_text)', escapeHtml('y'.repeat(1200)).length === 1200);
  // The draft body is delivered inside <pre>…</pre> (HTML) so Telegram shows its
  // native one-tap copy icon for ANY length — verified in index.js wiring.
  const idxSrc = require('fs').readFileSync(require('path').join(__dirname, '../agents/content-bot/index.js'), 'utf8');
  T('index sends draft as <pre> HTML block with copy icon', /<pre>\$\{escapeHtml\(draft\)\}<\/pre>/.test(idxSrc) && /parse_mode: 'HTML'/.test(idxSrc));

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
