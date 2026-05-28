'use strict';
/**
 * font-test-v3.js — Fixes applied:
 *   1. Ligature bug: noLig() strips fi/fl with U+200C (ZWNJ)
 *   2. Blank pages: all addPage() include {size:'A4'} — pdfkit defaults to Letter otherwise
 *   3. No test blocks (icons grid, status dot test, cyrillic test removed from leads)
 *
 * Run from /home/admin/acrogym/:  node font-test-v3.js
 */

const PDFDocument = require('pdfkit');
const fs          = require('fs');
const icons       = require('./shared/pdf-icons');

const FONT  = '/usr/share/fonts/truetype/montserrat/';
const BLUE  = '#28347F';
const ORANGE= '#F37021';
const GREY  = '#666666';
const DARK  = '#1A1A2E';
const WHITE = '#FFFFFF';
const LIGHT = '#F8F9FA';

// ── Fix 1: Prevent fi/fl ligature glyph substitution ─────────────────────────
// Inserting U+200C (ZERO WIDTH NON-JOINER) breaks OpenType liga lookups.
function noLig(str) {
  return String(str == null ? '' : str)
    .replace(/fi/g, 'f‌i')
    .replace(/fl/g, 'f‌l')
    .replace(/ff/g, 'f‌f');
}

// ── Fix 2: always pass size:'A4' to every addPage ────────────────────────────
const PAGE = { size: 'A4', margin: 0 };

const doc = new PDFDocument({ size: 'A4', margin: 0 });

// Register fonts once
doc.registerFont('M-Black',    FONT + 'Montserrat-Black.ttf');
doc.registerFont('M-ExtraBold',FONT + 'Montserrat-ExtraBold.ttf');
doc.registerFont('M-Bold',     FONT + 'Montserrat-Bold.ttf');
doc.registerFont('M-SemiBold', FONT + 'Montserrat-SemiBold.ttf');
doc.registerFont('M-Regular',  FONT + 'Montserrat-Regular.ttf');
doc.registerFont('M-Light',    FONT + 'Montserrat-Light.ttf');

doc.pipe(fs.createWriteStream('/tmp/font-test-v3.pdf'));

const W = doc.page.width;   // 595.28
const H = doc.page.height;  // 841.89
const M = 40;               // page margin

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Single-line text — never causes page overflow */
function txt(text, x, y, opts = {}) {
  doc.text(noLig(text), x, y, { lineBreak: false, ...opts });
}

/** Wrapped text (multi-line) with explicit width — safe wrapper */
function par(text, x, y, opts = {}) {
  doc.text(noLig(text), x, y, opts);
}

/** Page footer — drawn at fixed bottom position */
function footer(leftText, rightText, pageNum, total) {
  const fy = H - 34;
  doc.rect(0, H - 44, W, 44).fill(LIGHT);
  doc.moveTo(M, H - 44).lineTo(W - M, H - 44).lineWidth(0.5).strokeColor('#E0E0E0').stroke();
  doc.fontSize(7.5).fillColor(GREY).font('M-Regular');
  txt(noLig(leftText),  M,   fy);
  txt(`Page ${pageNum} of ${total}`, W - M - 60, fy);
}

/** Section heading with optional lucide icon */
function sectionHead(iconName, text, y) {
  const iw = icons.draw(doc, iconName, M, y + 1, { size: 16, color: BLUE });
  doc.fontSize(13).fillColor(BLUE).font('M-ExtraBold');
  txt(text, M + iw, y);
  return y + 24;
}

// ═══════════════════════════════════════════════════════════════
// PAGE 1 — COVER
// ═══════════════════════════════════════════════════════════════

// Full-bleed background
doc.rect(0, 0, W, H).fill(BLUE);

// Logo (white version if available, else fallback text)
try {
  doc.image('./config/brand/logo-white.png', W / 2 - 60, 130, { width: 120 });
} catch {
  doc.fontSize(54).fillColor(WHITE).font('M-Black');
  txt('AcroGym', 0, 140, { width: W, align: 'center' });
}

// Report type
doc.fontSize(26).fillColor(WHITE).font('M-ExtraBold');
txt('MONTHLY REPORT', 0, 300, { width: W, align: 'center' });

// Period
doc.fontSize(15).fillColor('rgba(255,255,255,0.75)').font('M-Regular');
txt('May 2026', 0, 338, { width: W, align: 'center' });

// Divider
doc.moveTo(80, 374).lineTo(W - 80, 374).lineWidth(0.5).strokeColor('rgba(255,255,255,0.3)').stroke();

// Generated date
doc.fontSize(10).fillColor('rgba(255,255,255,0.5)').font('M-Light');
txt(noLig('Generated 2026-05-27'), 0, 390, { width: W, align: 'center' });

// No footer on cover — intentional

// ═══════════════════════════════════════════════════════════════
// PAGE 2 — EXECUTIVE SUMMARY
// ═══════════════════════════════════════════════════════════════
doc.addPage(PAGE);
doc.rect(0, 0, W, H).fill(WHITE);

// Header strip
doc.rect(0, 0, W, 52).fill(BLUE);
doc.fontSize(12).fillColor(WHITE).font('M-Bold');
txt('EXECUTIVE SUMMARY', M, 19);
doc.fontSize(9).fillColor('rgba(255,255,255,0.65)').font('M-Regular');
txt('May 2026', W - M - 45, 21);

// ── Big 3 numbers ──
const colW = (W - M * 2) / 3;
const COLS = [
  { label: 'NEW LEADS',      value: '38',  sub: '+12% vs Apr', real: true  },
  { label: 'REVENUE (QAR)',  value: '—',   sub: 'in2 pending', real: false },
  { label: 'ACTIVE MEMBERS', value: '—',   sub: 'in2 pending', real: false },
];

COLS.forEach((col, i) => {
  const cx = M + i * colW;
  // Big number
  doc.fontSize(col.real ? 54 : 32)
     .fillColor(col.real ? ORANGE : '#C8C8C8')
     .font('M-Black');
  txt(col.value, cx, 68, { width: colW, align: 'center' });
  // Label
  doc.fontSize(8).fillColor(GREY).font('M-Bold');
  txt(col.label, cx, 138, { width: colW, align: 'center' });
  // Sub
  doc.fontSize(7.5).fillColor(col.real ? '#16A34A' : '#C8C8C8').font('M-Regular');
  txt(noLig(col.sub), cx, 152, { width: colW, align: 'center' });
  // Column separator
  if (i < 2) {
    doc.moveTo(M + (i + 1) * colW, 62).lineTo(M + (i + 1) * colW, 170)
       .lineWidth(0.5).strokeColor('#E5E5E5').stroke();
  }
});

// ── Status indicators (vertical, one per line) ──
const STATUS_Y = 182;
doc.rect(M, STATUS_Y, W - M * 2, 82).fill(LIGHT)
   .roundedRect(M, STATUS_Y, W - M * 2, 82, 5).fill(LIGHT);

const STATUSES = [
  { dot: 'status_red',    line: noLig('Revenue: behind target (in2 data pending)')    },
  { dot: 'status_yellow', line: noLig('Leads: on pace (38 this month, target 40)')    },
  { dot: 'status_red',    line: noLig('Response: behind target (avg 4.2h, goal ≤2h)') },
];

STATUSES.forEach((s, i) => {
  const sy = STATUS_Y + 10 + i * 22;
  const iw = icons.draw(doc, s.dot, M + 12, sy, { size: 12 });
  doc.fontSize(9.5).fillColor(DARK).font('M-SemiBold');
  txt(s.line, M + 12 + iw, sy + 1);
});

// ── Key Events ──
const KE_Y = 278;
doc.fontSize(12).fillColor(BLUE).font('M-ExtraBold');
txt('Key Events', M, KE_Y);

const EVENTS = [
  { icon: 'TrendingUp',    color: '#16A34A', text: noLig('38 new leads this month — highest since February')       },
  { icon: 'Package',       color: ORANGE,    text: noLig('Revenue & attendance data pending in2 (Aug 2026)')        },
  { icon: 'AlertTriangle', color: '#DC2626', text: noLig('Avg first-response time 4.2h — target ≤2h not met')     },
];

EVENTS.forEach((ev, i) => {
  const ey = KE_Y + 22 + i * 30;
  doc.rect(M, ey, 3, 22).fill(ev.color);
  const iw = icons.draw(doc, ev.icon, M + 10, ey + 4, { size: 13, color: ev.color });
  doc.fontSize(9.5).fillColor(DARK).font('M-Regular');
  par(ev.text, M + 10 + iw, ey + 5, { width: W - M * 2 - 30 });
});

footer('AcroGym · Monthly Report', '', 2, 4);

// ═══════════════════════════════════════════════════════════════
// PAGE 3 — LEADS & PIPELINE
// ═══════════════════════════════════════════════════════════════
doc.addPage(PAGE);
doc.rect(0, 0, W, H).fill(WHITE);

// Header
doc.rect(0, 0, W, 52).fill(BLUE);
doc.fontSize(12).fillColor(WHITE).font('M-Bold');
txt('LEADS & PIPELINE', M, 19);
doc.fontSize(9).fillColor('rgba(255,255,255,0.65)').font('M-Regular');
txt('May 2026', W - M - 45, 21);

// ── Conversion Funnel (table) ──
doc.fontSize(11).fillColor(BLUE).font('M-ExtraBold');
txt('Conversion Funnel', M, 66);

const FUNNEL = [
  { stage: noLig('Submitted'),      count: '38', pct: '100%', real: true  },
  { stage: noLig('Responded'),      count: '31', pct:  '82%', real: true  },
  { stage: noLig('Trial Booked'),   count:  '—', pct:   '—',  real: false },
  { stage: noLig('Trial Attended'), count:  '—', pct:   '—',  real: false },
  { stage: noLig('Subscribed'),     count:  '—', pct:   '—',  real: false },
];

FUNNEL.forEach((row, i) => {
  const ry = 84 + i * 26;
  if (i % 2 === 0) doc.rect(M, ry, W - M * 2, 25).fill(LIGHT);
  doc.fontSize(9.5).fillColor(row.real ? DARK : '#BBBBBB').font('M-Regular');
  txt(row.stage, M + 8, ry + 7);
  doc.fontSize(12).fillColor(row.real ? BLUE : '#CCCCCC').font('M-Bold');
  txt(row.count, 0, ry + 5, { width: W - M - 80, align: 'right' });
  doc.fontSize(8.5).fillColor(row.real ? GREY : '#DDDDDD').font('M-Regular');
  txt(row.pct, 0, ry + 8, { width: W - M - 8, align: 'right' });
});

// ── in2 placeholder ──
const PH_Y = 84 + FUNNEL.length * 26 + 10;
doc.rect(M, PH_Y, W - M * 2, 64).fill('#FFF8F0')
   .roundedRect(M, PH_Y, W - M * 2, 64, 6).fill('#FFF8F0');
doc.rect(M, PH_Y, 4, 64).fill(ORANGE);
const piw = icons.draw(doc, 'Package', M + 14, PH_Y + 12, { size: 17, color: ORANGE });
doc.fontSize(10.5).fillColor(ORANGE).font('M-Bold');
txt(noLig('Coming with in2 integration'), M + 14 + piw, PH_Y + 13);
doc.fontSize(8.5).fillColor(GREY).font('M-Regular');
par(noLig('Trial bookings, attendance tracking, subscriptions and revenue will populate automatically after in2 API goes live (August 2026).'),
    M + 14 + piw, PH_Y + 30, { width: W - M * 2 - 50 });

// ── Source breakdown (placeholder — real data via chart.js in production) ──
const SRC_Y = PH_Y + 76;
doc.fontSize(11).fillColor(BLUE).font('M-ExtraBold');
txt('Lead Sources', M, SRC_Y);

const SOURCES = [
  { label: 'Instagram',  pct: 58, color: BLUE   },
  { label: 'Website',    pct: 24, color: ORANGE  },
  { label: 'Referral',   pct: 13, color: '#5A6BC4' },
  { label: 'Other',      pct:  5, color: '#FF9755' },
];

// Simple horizontal bar chart — no external lib needed
const BAR_X = M;
const BAR_W = W - M * 2;
SOURCES.forEach((src, i) => {
  const by = SRC_Y + 20 + i * 28;
  const barW = (src.pct / 100) * (BAR_W - 120);
  // Label
  doc.fontSize(9).fillColor(DARK).font('M-Regular');
  txt(src.label, BAR_X, by + 4, { width: 80 });
  // Bar bg
  doc.rect(BAR_X + 85, by, BAR_W - 120, 14).fill('#EEEEEE');
  // Bar fill
  doc.rect(BAR_X + 85, by, barW, 14).fill(src.color);
  // Pct label
  doc.fontSize(9).fillColor(DARK).font('M-Bold');
  txt(`${src.pct}%`, BAR_X + 85 + barW + 6, by + 3);
});

// ── Response time note ──
const RT_Y = SRC_Y + 20 + SOURCES.length * 28 + 14;
doc.rect(M, RT_Y, W - M * 2, 50).fill(LIGHT)
   .roundedRect(M, RT_Y, W - M * 2, 50, 5).fill(LIGHT);
const ziw = icons.draw(doc, 'Zap', M + 12, RT_Y + 12, { size: 16, color: '#DC2626' });
doc.fontSize(10.5).fillColor('#DC2626').font('M-Bold');
txt(noLig('Response Time'), M + 12 + ziw, RT_Y + 13);
doc.fontSize(9).fillColor(DARK).font('M-Regular');
txt(noLig('Avg first response: 4.2h  ·  Target: ≤ 2h  ·  Status: behind'), M + 12 + ziw, RT_Y + 30);

footer('AcroGym · Monthly Report', '', 3, 4);

// ═══════════════════════════════════════════════════════════════
// PAGE 4 — IN2 PLACEHOLDERS (Attendance / Revenue / Coaches)
// ═══════════════════════════════════════════════════════════════
doc.addPage(PAGE);
doc.rect(0, 0, W, H).fill(WHITE);

// Header
doc.rect(0, 0, W, 52).fill(BLUE);
doc.fontSize(12).fillColor(WHITE).font('M-Bold');
txt('ATTENDANCE, REVENUE & COACHES', M, 19);
doc.fontSize(9).fillColor('rgba(255,255,255,0.65)').font('M-Regular');
txt('May 2026', W - M - 45, 21);

const PH_SECTIONS = [
  { icon: 'BarChart3', title: 'Attendance',
    sub: noLig('Total visits, per-coach attendance, group fill rates') },
  { icon: 'TrendingUp', title: 'Revenue',
    sub: noLig('Monthly revenue, QAR per session, coach compensation') },
  { icon: 'User', title: 'Coach Overview',
    sub: noLig('Session counts, performance metrics, feedback scores') },
];

const SEC_H  = 220;
const SEC_START = 62;

PH_SECTIONS.forEach((sec, i) => {
  const sy = SEC_START + i * SEC_H;
  // Section header
  const iw2 = icons.draw(doc, sec.icon, M, sy + 2, { size: 15, color: BLUE });
  doc.fontSize(12).fillColor(BLUE).font('M-ExtraBold');
  txt(sec.title, M + iw2, sy);

  // Placeholder box
  const bx = M, by = sy + 22, bw = W - M * 2, bh = 175;
  doc.rect(bx, by, bw, bh).fill(LIGHT)
     .roundedRect(bx, by, bw, bh, 8).fill(LIGHT);
  doc.roundedRect(bx, by, bw, bh, 8).lineWidth(1).strokeColor('#E0E0E0').stroke();

  // Centered icon
  icons.draw(doc, 'Package', W / 2 - 22, by + 44, { size: 44, color: '#CCCCCC' });

  // Centered text
  doc.fontSize(12).fillColor('#AAAAAA').font('M-SemiBold');
  txt(noLig('Coming with in2 integration'), 0, by + 100, { width: W, align: 'center' });
  doc.fontSize(8.5).fillColor('#BBBBBB').font('M-Regular');
  txt(sec.sub, 0, by + 118, { width: W, align: 'center' });
  doc.fontSize(8).fillColor('#CCCCCC').font('M-Light');
  txt('Expected: August 2026', 0, by + 136, { width: W, align: 'center' });
});

footer('AcroGym · Monthly Report', '', 4, 4);

doc.end();
console.log('font-test-v3.pdf → /tmp/font-test-v3.pdf');
