'use strict';

/**
 * shared/pdf-icons.js
 *
 * Draws brand-safe icons in pdfkit PDFDocument.
 *
 * Strategy (no emoji font needed):
 *   - Status indicators (🔴🟡🟢) → filled colored circles (Material Design style)
 *   - Section/UI icons          → Lucide SVG paths scaled to size
 *   - Brand logo (🤸)           → doc.image() from config/brand/
 *
 * API:
 *   icons.draw(doc, nameOrEmoji, x, y, { size, color, fill, logoPath })
 *   → returns width occupied (use to position text after icon)
 *
 * Lucide icon viewBox is always 24×24. We scale via CTM transform.
 */

const path   = require('path');
const lucide = require('lucide');

// ─────────────────────────────────────────────────────────────
// Emoji → internal name map
// ─────────────────────────────────────────────────────────────
const EMOJI_MAP = {
  // Status indicators (drawn as circles, not lucide)
  '🔴': 'status_red',
  '🟡': 'status_yellow',
  '🟢': 'status_green',

  // Section icons → lucide name
  '📊': 'BarChart3',
  '📈': 'TrendingUp',
  '📍': 'MapPin',
  '💡': 'Lightbulb',
  '🚨': 'AlertTriangle',
  '⚠':  'AlertTriangle',
  '🔥': 'Flame',
  '🤖': 'Bot',
  '✅': 'CheckCircle',
  '❌': 'XCircle',
  '⛔': 'XCircle',
  '❓': 'HelpCircle',
  '📅': 'Calendar',
  '📆': 'CalendarDays',
  '🗓': 'CalendarDays',
  '📤': 'Upload',
  '🌍': 'Globe',
  '🌐': 'Globe',
  '🛠': 'Wrench',
  '📦': 'Package',
  '📬': 'Mail',
  '📱': 'Smartphone',
  '🔄': 'RefreshCw',
  '⚡': 'Zap',
  '🎯': 'Target',
  '📄': 'FileText',
  '📋': 'ClipboardList',
  '👁': 'Eye',
  '👤': 'User',
  '✍': 'PenLine',
  '🎉': 'Sparkles',
  '🌙': 'Moon',
  '👆': 'MousePointer',

  // Brand logo
  '🤸': 'logo',
};

// Status indicator fill colors
const STATUS_COLORS = {
  status_red:    '#DC2626',
  status_yellow: '#F59E0B',
  status_green:  '#16A34A',
};

const BRAND_DIR = path.join(__dirname, '../config/brand');

// ─────────────────────────────────────────────────────────────
// Draw one Lucide icon element (path / circle / rect / line / polyline)
// using pdfkit CTM transform to scale from 24×24 viewBox
// ─────────────────────────────────────────────────────────────
function _drawLucideElement(doc, tag, attrs, scale, ox, oy, color, filled) {
  const lw = 2 * scale; // Lucide stroke-width is 2 on 24px viewBox

  if (tag === 'path') {
    // Apply affine transform: scale to size, offset to (ox, oy)
    doc.save();
    doc.transform(scale, 0, 0, scale, ox, oy);
    const p = doc.path(attrs.d).lineWidth(2);
    if (filled || (attrs.fill && attrs.fill !== 'none' && attrs.fill !== 'currentColor')) {
      p.fillAndStroke(color, color);
    } else {
      p.strokeColor(color).stroke();
    }
    doc.restore();

  } else if (tag === 'circle') {
    const cx = parseFloat(attrs.cx) * scale + ox;
    const cy = parseFloat(attrs.cy) * scale + oy;
    const r  = parseFloat(attrs.r)  * scale;
    const c  = doc.circle(cx, cy, r).lineWidth(lw);
    if (attrs.fill && attrs.fill !== 'none' && attrs.fill !== 'currentColor') {
      c.fillAndStroke(color, color);
    } else {
      c.strokeColor(color).stroke();
    }

  } else if (tag === 'rect') {
    const rx = parseFloat(attrs.x      || 0) * scale + ox;
    const ry = parseFloat(attrs.y      || 0) * scale + oy;
    const rw = parseFloat(attrs.width  || 0) * scale;
    const rh = parseFloat(attrs.height || 0) * scale;
    doc.rect(rx, ry, rw, rh).lineWidth(lw).strokeColor(color).stroke();

  } else if (tag === 'line') {
    const x1 = parseFloat(attrs.x1) * scale + ox;
    const y1 = parseFloat(attrs.y1) * scale + oy;
    const x2 = parseFloat(attrs.x2) * scale + ox;
    const y2 = parseFloat(attrs.y2) * scale + oy;
    doc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(lw).strokeColor(color).stroke();

  } else if (tag === 'polyline' || tag === 'polygon') {
    const pts = (attrs.points || '').trim().split(/[\s,]+/).map(Number);
    doc.save();
    doc.transform(scale, 0, 0, scale, ox, oy);
    if (pts.length >= 2) {
      doc.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) doc.lineTo(pts[i], pts[i + 1]);
      if (tag === 'polygon') doc.closePath();
    }
    doc.lineWidth(2).strokeColor(color).stroke();
    doc.restore();
  }
  // 'ellipse', 'text', etc. — not used by Lucide, skip
}

// ─────────────────────────────────────────────────────────────
// Draw a Lucide icon by its camelCase name
// ─────────────────────────────────────────────────────────────
function _drawLucide(doc, lucideName, x, y, size, color, filled = false) {
  const iconData = lucide[lucideName];
  if (!iconData) return;

  const scale = size / 24;
  for (const [tag, attrs] of iconData) {
    _drawLucideElement(doc, tag, attrs, scale, x, y, color, filled);
  }
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Draw an icon at (x, y).
 *
 * @param {PDFDocument} doc
 * @param {string}      nameOrEmoji   emoji character or internal/lucide name
 * @param {number}      x             left edge of icon bounding box
 * @param {number}      y             top edge of icon bounding box
 * @param {object}      [opts]
 * @param {number}      [opts.size=16]         icon square size in pt
 * @param {string}      [opts.color='#28347F'] stroke/fill color
 * @param {boolean}     [opts.filled=false]    fill paths instead of stroke
 * @param {string}      [opts.logoPath]        override path to logo PNG
 * @returns {number}  width consumed (icon size + 2px gap) — use to place text
 */
function draw(doc, nameOrEmoji, x, y, opts = {}) {
  const {
    size      = 16,
    color     = '#28347F',
    filled    = false,
    logoPath,
  } = opts;

  // Resolve emoji → internal name
  const name = EMOJI_MAP[nameOrEmoji] || nameOrEmoji;

  // ── Brand logo ──────────────────────────────────────────────
  if (name === 'logo') {
    const lp = logoPath
      || path.join(BRAND_DIR, 'logo.png');
    try {
      // Vertically centre within size
      doc.image(lp, x, y, { height: size });
    } catch {
      // logo file missing — draw placeholder circle
      doc.circle(x + size / 2, y + size / 2, size / 2)
         .lineWidth(1).strokeColor(color).stroke();
    }
    return size + 4;
  }

  // ── Status indicator (colored filled circle) ─────────────────
  if (name in STATUS_COLORS) {
    const cx = x + size / 2;
    const cy = y + size / 2;
    doc.circle(cx, cy, size / 2).fill(STATUS_COLORS[name]);
    return size + 4;
  }

  // ── Lucide icon ──────────────────────────────────────────────
  if (lucide[name]) {
    _drawLucide(doc, name, x, y, size, color, filled);
    return size + 4;
  }

  // ── Unknown — draw a small grey square placeholder ────────────
  doc.rect(x, y, size, size)
     .lineWidth(1).strokeColor('#CCCCCC').stroke();
  return size + 4;
}

/**
 * Convenience: draw icon + text on same baseline.
 *
 * @param {PDFDocument} doc
 * @param {string}      nameOrEmoji
 * @param {string}      text
 * @param {number}      x
 * @param {number}      y
 * @param {object}      [opts]           passed to draw() plus:
 * @param {number}      [opts.gap=4]     extra gap between icon and text
 * @param {object}      [opts.textOpts]  pdfkit text() options
 */
function drawWithText(doc, nameOrEmoji, text, x, y, opts = {}) {
  const { gap = 4, textOpts = {}, ...iconOpts } = opts;
  const iconW = draw(doc, nameOrEmoji, x, y, iconOpts);
  doc.text(text, x + iconW + gap, y, textOpts);
}

module.exports = { draw, drawWithText, EMOJI_MAP, STATUS_COLORS };
