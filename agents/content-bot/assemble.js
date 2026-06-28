'use strict';

/**
 * Visual assembly — ALL through Canva (Agent 4 — autonomous posting, Phase 2).
 *
 * 🔴 Owner directive: visuals are built ONLY through Canva (brand templates +
 *    brand kit), never hand-composed. This module: pull real photo → upload as
 *    a Canva asset → autofill the brand template (cover / inner) → export.
 *    Returns both the export URL (for Metricool) and a buffer (for verify.js).
 *
 * Templates & field names live in data/canva-templates.json (see
 * canva-templates.example.json). Logical keys: cover{headline,photo,cta},
 * content{headline,photo,body}. Story/Reel reuse the same autofill mechanism
 * with their own template ids (1080×1920; reels export as mp4).
 */

const fs = require('fs');
const path = require('path');
const canva = require('./canva');
const { generateContent } = require('./generate');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('content-bot');

const TEMPLATES_PATH = path.join(__dirname, '../../data/canva-templates.json');

function loadTemplates() {
  try {
    const cfg = JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf8'));
    return cfg;
  } catch {
    throw new Error('canva-templates.json missing — copy canva-templates.example.json to data/canva-templates.json and fill real template ids/field names');
  }
}

function isConfigured() {
  return canva.isConfigured() && fs.existsSync(TEMPLATES_PATH);
}

// Fetch a Canva export URL into a Buffer (for verification).
async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`canva export download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Build ONE slide from a template key ('cover' | 'content' | 'story' | 'reel').
 * @param {string} key
 * @param {object} content { headline, body, cta, photoBuffer, photoName }
 * @param {string} [format] export format: 'png' (default) or 'mp4' (reel)
 * @returns {Promise<{url:string, buffer:Buffer|null, designId:string}>}
 */
async function buildSlide(key, content, format = 'png') {
  const templates = loadTemplates();
  const tpl = templates[key];
  if (!tpl || !tpl.templateId || /^PASTE_/.test(tpl.templateId)) {
    throw new Error(`template "${key}" not configured in canva-templates.json`);
  }
  const f = tpl.fields || {};
  const data = {};
  if (f.headline && content.headline != null) data[f.headline] = { type: 'text', text: String(content.headline) };
  if (f.body && content.body != null) data[f.body] = { type: 'text', text: String(content.body) };
  if (f.cta && content.cta != null) data[f.cta] = { type: 'text', text: String(content.cta) };
  if (f.photo && content.photoBuffer) {
    const assetId = await canva.uploadAsset(content.photoBuffer, content.photoName || `photo-${Date.now()}.jpg`);
    data[f.photo] = { type: 'image', asset_id: assetId };
  }

  const result = await canva.autofill(tpl.templateId, data, `acrogym-${key}-${Date.now()}`);
  const designId = result.design && (result.design.id || result.design.design_id);
  if (!designId) throw new Error(`canva autofill (${key}): no design id`);
  const urls = await canva.exportDesign(designId, format);
  if (!urls.length) throw new Error(`canva export (${key}): no url`);
  const buffer = format === 'png' ? await fetchBuffer(urls[0]) : null; // verify images only
  logger.info({ key, designId, format }, 'slide built via Canva');
  return { url: urls[0], buffer, designId };
}

/**
 * Assemble a full carousel POST through Canva.
 * @param {object} p
 * @param {string} p.topic                  theme (also used for the caption)
 * @param {Array<{buffer:Buffer,name?:string}>} p.photos  ordered photos (slide 1 = cover)
 * @param {object} p.cover    { headline, cta }
 * @param {Array<{headline:string,body:string}>} p.inner  text for slides 2..n
 * @param {string} [p.caption]               override; otherwise generated
 * @returns {Promise<{caption:string, slides:Array<{url,buffer,alt}>}>}
 */
async function assembleCarousel({ topic, photos, cover, inner, caption }) {
  if (!isConfigured()) throw new Error('Canva pipeline not configured (canva auth + canva-templates.json)');
  if (!photos || photos.length < 1) throw new Error('assembleCarousel: need at least the cover photo');

  const slides = [];

  // Slide 1 — cover (color, headline + CTA pill).
  const coverSlide = await buildSlide('cover', {
    headline: cover.headline,
    cta: cover.cta,
    photoBuffer: photos[0].buffer,
    photoName: photos[0].name,
  });
  slides.push({ ...coverSlide, alt: `${cover.headline} — AcroGym` });

  // Slides 2..n — inner (brand duotone template), one per inner text/photo.
  for (let i = 0; i < inner.length; i++) {
    const photo = photos[i + 1] || photos[photos.length - 1];
    const s = await buildSlide('content', {
      headline: inner[i].headline,
      body: inner[i].body,
      photoBuffer: photo.buffer,
      photoName: photo.name,
    });
    slides.push({ ...s, alt: `${inner[i].headline} — AcroGym` });
  }

  const cap = caption || await generateContent('post', topic);
  return { caption: cap, slides };
}

module.exports = { isConfigured, loadTemplates, buildSlide, assembleCarousel, TEMPLATES_PATH };
