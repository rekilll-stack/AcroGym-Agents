'use strict';

/**
 * shared/pptx-icons.js
 *
 * Generates Lucide SVG icons as base64 data-URI strings
 * for insertion into pptxgenjs slides via slide.addImage().
 *
 * Strategy: build minimal SVG strings from Lucide's JS icon data,
 * encode as base64 — no canvas/rasterisation needed.
 * pptxgenjs supports SVG images natively.
 *
 * Usage:
 *   const icons = require('../../../shared/pptx-icons');
 *   slide.addImage({ data: icons.svg('TrendingUp', '#F37021'), x, y, w, h });
 *   // or colored circle:
 *   slide.addImage({ data: icons.circle('#DC2626'), x, y, w, h });
 */

const lucide = require('lucide');

// ─────────────────────────────────────────────────────────────
// Build SVG element string from Lucide attribute object
// ─────────────────────────────────────────────────────────────
function _attrs(obj) {
  return Object.entries(obj)
    .filter(([k]) => k !== 'xmlns')
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
}

/**
 * Generate a Lucide icon as an SVG data-URI.
 *
 * @param {string} name     — camelCase Lucide icon name (e.g. 'TrendingUp')
 * @param {string} color    — hex color with #, e.g. '#F37021'
 * @param {number} [size]   — viewBox size hint (default 48, purely cosmetic)
 * @returns {string}        — 'data:image/svg+xml;base64,...' or empty string if unknown
 */
function svg(name, color = '#28347F', size = 48) {
  const iconData = lucide[name];
  if (!iconData) return '';

  const col = color.replace('#', '');
  const elements = iconData
    .map(([tag, a]) => `<${tag} ${_attrs(a)}/>`)
    .join('');

  const svgStr = [
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    ` viewBox="0 0 24 24" width="${size}" height="${size}"`,
    ` fill="none" stroke="#${col}"`,
    ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`,
    elements,
    `</svg>`,
  ].join('');

  return 'data:image/svg+xml;base64,' + Buffer.from(svgStr).toString('base64');
}

/**
 * Generate a solid filled circle as an SVG data-URI.
 * Used for status indicators (🔴🟡🟢).
 *
 * @param {string} fillColor  — hex color with #
 * @param {number} [size]     — viewBox size (default 16)
 * @returns {string}          — 'data:image/svg+xml;base64,...'
 */
function circle(fillColor = '#DC2626', size = 16) {
  const r = size / 2;
  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r}" fill="${fillColor}"/></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svgStr).toString('base64');
}

/**
 * Generate a solid color rectangle (e.g. orange left-border accent).
 *
 * @param {string} fillColor  — hex color with #
 * @param {number} [w]
 * @param {number} [h]
 * @returns {string}
 */
function rect(fillColor = '#F37021', w = 4, h = 20) {
  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fillColor}"/></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svgStr).toString('base64');
}

module.exports = { svg, circle, rect };
