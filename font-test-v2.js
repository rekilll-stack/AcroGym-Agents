'use strict';
/**
 * font-test-v2.js — проверка Montserrat TTF + pdf-icons.js (без эмодзи)
 * Запускать из /home/admin/acrogym/: node font-test-v2.js
 */

const PDFDocument = require('pdfkit');
const fs          = require('fs');
const icons       = require('./shared/pdf-icons');

const FONT    = '/usr/share/fonts/truetype/montserrat/';
const BLUE    = '#28347F';
const ORANGE  = '#F37021';
const GREY    = '#666666';
const DARK    = '#1A1A2E';

const doc = new PDFDocument({ size: 'A4', margin: 0 });
doc.pipe(fs.createWriteStream('/tmp/font-test-v2.pdf'));

// Register fonts
doc.registerFont('M-Black',     FONT + 'Montserrat-Black.ttf');
doc.registerFont('M-ExtraBold', FONT + 'Montserrat-ExtraBold.ttf');
doc.registerFont('M-Bold',      FONT + 'Montserrat-Bold.ttf');
doc.registerFont('M-SemiBold',  FONT + 'Montserrat-SemiBold.ttf');
doc.registerFont('M-Regular',   FONT + 'Montserrat-Regular.ttf');
doc.registerFont('M-Light',     FONT + 'Montserrat-Light.ttf');

const W = doc.page.width;   // 595
const H = doc.page.height;  // 842

// ═══════════════════════════════════════════════
// PAGE 1 — COVER (имитация брендированной обложки)
// ═══════════════════════════════════════════════

// Background
doc.rect(0, 0, W, H).fill(BLUE);

// Logo placeholder (если файл есть — подставится, иначе кружок)
try {
  doc.image('./config/brand/logo-white.png', W/2 - 60, 120, { width: 120 });
} catch {
  // fallback — нарисуем текст AcroGym крупно
  doc.fontSize(52).fillColor('#FFFFFF').font('M-Black')
     .text('AcroGym', 0, 140, { align: 'center', width: W });
}

// Cover title
doc.fontSize(28).fillColor('#FFFFFF').font('M-ExtraBold')
   .text('MONTHLY REPORT', 0, 280, { align: 'center', width: W });

doc.fontSize(16).fillColor('rgba(255,255,255,0.75)').font('M-Regular')
   .text('May 2026  ·  AcroGym Doha', 0, 320, { align: 'center', width: W });

// Horizontal divider
doc.moveTo(80, 365).lineTo(W - 80, 365).lineWidth(1).strokeColor('rgba(255,255,255,0.3)').stroke();

// Subtitle line
doc.fontSize(11).fillColor('rgba(255,255,255,0.6)').font('M-Light')
   .text('Confidential · Generated 2026-05-27', 0, 380, { align: 'center', width: W });

// Bottom badge
doc.rect(0, H - 60, W, 60).fill('rgba(0,0,0,0.2)');
doc.fontSize(10).fillColor('rgba(255,255,255,0.5)').font('M-Regular')
   .text('Page 1 of 4', 40, H - 38);
doc.fontSize(10).fillColor('rgba(255,255,255,0.5)').font('M-Regular')
   .text('acrogym.qa', 0, H - 38, { align: 'right', width: W - 40 });

// ═══════════════════════════════════════════════
// PAGE 2 — EXECUTIVE SUMMARY (big numbers + status)
// ═══════════════════════════════════════════════
doc.addPage({ margin: 0 });
doc.rect(0, 0, W, H).fill('#FFFFFF');

// Header strip
doc.rect(0, 0, W, 56).fill(BLUE);
doc.fontSize(13).fillColor('#FFFFFF').font('M-Bold')
   .text('EXECUTIVE SUMMARY', 40, 20);
doc.fontSize(10).fillColor('rgba(255,255,255,0.7)').font('M-Regular')
   .text('May 2026', 0, 22, { align: 'right', width: W - 40 });

const M = 40; // margin

// Big 3 numbers row
const cols = [
  { label: 'NEW LEADS',      value: '38',    sub: '+12% vs Apr' },
  { label: 'REVENUE (QAR)',  value: '—',     sub: 'in2 pending'  },
  { label: 'ACTIVE MEMBERS', value: '—',     sub: 'in2 pending'  },
];
const colW = (W - M * 2) / 3;

cols.forEach((col, i) => {
  const cx = M + i * colW + colW / 2;
  const isReal = col.value !== '—';

  // Big number
  doc.fontSize(isReal ? 56 : 36)
     .fillColor(isReal ? ORANGE : '#CCCCCC')
     .font('M-Black')
     .text(col.value, M + i * colW, 80, { width: colW, align: 'center' });

  // Label
  doc.fontSize(9).fillColor(GREY).font('M-Bold')
     .text(col.label, M + i * colW, 150, { width: colW, align: 'center' });

  // Sub label
  doc.fontSize(8).fillColor(isReal ? '#16A34A' : '#CCCCCC').font('M-Regular')
     .text(col.sub, M + i * colW, 165, { width: colW, align: 'center' });

  // Separator (not after last)
  if (i < 2) {
    doc.moveTo(M + (i + 1) * colW, 75).lineTo(M + (i + 1) * colW, 185)
       .lineWidth(0.5).strokeColor('#E5E5E5').stroke();
  }
});

// Status traffic light row
doc.rect(M, 195, W - M * 2, 44).fill('#F8F9FA').roundedRect(M, 195, W - M * 2, 44, 4).fill('#F8F9FA');

const statuses = [
  { name: 'status_red',    label: 'Revenue: behind target' },
  { name: 'status_yellow', label: 'Leads: on pace'         },
  { name: 'status_green',  label: 'Response: ahead'        },
];

const statusColW = (W - M * 2) / 3;
statuses.forEach((s, i) => {
  const sx = M + i * statusColW + 12;
  const sy = 195 + 14;
  const iw = icons.draw(doc, s.name, sx, sy, { size: 14 });
  doc.fontSize(10).fillColor(DARK).font('M-SemiBold')
     .text(s.label, sx + iw, sy + 1);
});

// Key events section
doc.fontSize(13).fillColor(BLUE).font('M-ExtraBold')
   .text('Key Events', M, 258);

const events = [
  { icon: 'TrendingUp',    text: '38 new leads this month — highest since February',  color: '#16A34A' },
  { icon: 'AlertTriangle', text: 'Revenue data pending in2 integration (Aug 2026)',   color: ORANGE    },
  { icon: 'Zap',           text: 'Avg first-response time: 4.2 hours (target ≤ 2h)', color: '#DC2626' },
];

events.forEach((ev, i) => {
  const ey = 278 + i * 30;
  // Accent bar
  doc.rect(M, ey, 3, 20).fill(ev.color);
  const iw = icons.draw(doc, ev.icon, M + 10, ey + 3, { size: 14, color: ev.color });
  doc.fontSize(10).fillColor(DARK).font('M-Regular')
     .text(ev.text, M + 10 + iw, ey + 4, { width: W - M * 2 - 30 });
});

// Footer
doc.rect(0, H - 40, W, 40).fill('#F8F9FA');
doc.fontSize(8).fillColor(GREY).font('M-Regular').text('AcroGym Doha · Confidential', M, H - 26);
doc.fontSize(8).fillColor(GREY).font('M-Regular').text('Page 2 of 4', 0, H - 26, { align: 'right', width: W - M });

// ═══════════════════════════════════════════════
// PAGE 3 — LEADS SECTION (typography + icons test)
// ═══════════════════════════════════════════════
doc.addPage({ margin: 0 });
doc.rect(0, 0, W, H).fill('#FFFFFF');
doc.rect(0, 0, W, 56).fill(BLUE);
doc.fontSize(13).fillColor('#FFFFFF').font('M-Bold').text('LEADS & PIPELINE', M, 20);
doc.fontSize(10).fillColor('rgba(255,255,255,0.7)').font('M-Regular').text('May 2026', 0, 22, { align: 'right', width: W - M });

// Funnel table
const funnel = [
  { stage: 'Submitted',       count: 38, pct: '100%', color: BLUE   },
  { stage: 'Responded',       count: 31, pct:  '82%', color: BLUE   },
  { stage: 'Trial Booked',    count: '—', pct:  '—',  color: '#CCC' },
  { stage: 'Trial Attended',  count: '—', pct:  '—',  color: '#CCC' },
  { stage: 'Subscribed',      count: '—', pct:  '—',  color: '#CCC' },
];

doc.fontSize(11).fillColor(BLUE).font('M-ExtraBold').text('Conversion Funnel', M, 72);

funnel.forEach((row, i) => {
  const ry = 92 + i * 28;
  const isReal = row.count !== '—';

  // Row bg
  if (i % 2 === 0) doc.rect(M, ry, W - M * 2, 26).fill('#F8F9FA');

  doc.fontSize(10).fillColor(isReal ? DARK : '#CCCCCC').font('M-Regular')
     .text(row.stage, M + 8, ry + 7);
  doc.fontSize(13).fillColor(row.color).font('M-Bold')
     .text(String(row.count), 0, ry + 5, { align: 'right', width: W - M - 80 });
  doc.fontSize(9).fillColor(isReal ? GREY : '#DDDDDD').font('M-Regular')
     .text(row.pct, 0, ry + 8, { align: 'right', width: W - M - 8 });
});

// In2 placeholder block
doc.rect(M, 240, W - M * 2, 70).fill('#FFF8F0').roundedRect(M, 240, W - M * 2, 70, 6).fill('#FFF8F0');
doc.rect(M, 240, 4, 70).fill(ORANGE);
const piw = icons.draw(doc, 'Package', M + 14, 254, { size: 18, color: ORANGE });
doc.fontSize(11).fillColor(ORANGE).font('M-Bold').text('Coming with in2 integration', M + 14 + piw, 255);
doc.fontSize(9).fillColor(GREY).font('M-Regular')
   .text('Trial bookings, attendance tracking, subscription conversions and revenue data\nwill populate automatically after in2 API goes live (August 2026).', M + 14 + piw, 272, { width: W - M * 2 - 50 });

// Section icon test row
doc.fontSize(11).fillColor(BLUE).font('M-ExtraBold').text('Icons test (all 14 used in PDF)', M, 330);

const iconTests = [
  ['BarChart3', 'Charts'],
  ['TrendingUp', 'Trends'],
  ['Target', 'Goals'],
  ['Zap', 'Speed'],
  ['AlertTriangle', 'Alerts'],
  ['CheckCircle', 'Done'],
  ['Flame', 'Hot'],
  ['Bot', 'AI'],
  ['Calendar', 'Date'],
  ['Upload', 'Export'],
  ['Globe', 'Language'],
  ['Package', 'Module'],
  ['User', 'Coach'],
  ['Wrench', 'Status'],
];

iconTests.forEach(([name, label], i) => {
  const col = i % 7;
  const row = Math.floor(i / 7);
  const ix = M + col * 74;
  const iy = 350 + row * 52;
  icons.draw(doc, name, ix + 22, iy, { size: 20, color: BLUE });
  doc.fontSize(8).fillColor(GREY).font('M-Regular').text(label, ix, iy + 24, { width: 68, align: 'center' });
});

// Status dots test
doc.fontSize(11).fillColor(BLUE).font('M-ExtraBold').text('Status indicators', M, 462);

[['status_red','Behind'], ['status_yellow','On pace'], ['status_green','Ahead']].forEach(([name, label], i) => {
  const sx = M + i * 120;
  const iw = icons.draw(doc, name, sx, 480, { size: 14 });
  doc.fontSize(10).fillColor(DARK).font('M-SemiBold').text(label, sx + iw, 482);
});

// Кирилица test
doc.fontSize(11).fillColor(BLUE).font('M-ExtraBold').text('Кириллица — проверка', M, 520);
doc.fontSize(10).fillColor(DARK).font('M-Regular')
   .text('Это тестовый абзац на русском языке. АкроДжим Доха — ведущий гимнастический клуб в Катаре. Кристина Мастер спорта, 5-кратная чемпионка России.', M, 538, { width: W - M * 2 });

// Footer
doc.rect(0, H - 40, W, 40).fill('#F8F9FA');
doc.fontSize(8).fillColor(GREY).font('M-Regular').text('AcroGym Doha · Confidential', M, H - 26);
doc.fontSize(8).fillColor(GREY).font('M-Regular').text('Page 3 of 4', 0, H - 26, { align: 'right', width: W - M });

// ═══════════════════════════════════════════════
// PAGE 4 — PLACEHOLDER (в стиле in2 секций)
// ═══════════════════════════════════════════════
doc.addPage({ margin: 0 });
doc.rect(0, 0, W, H).fill('#FFFFFF');
doc.rect(0, 0, W, 56).fill(BLUE);
doc.fontSize(13).fillColor('#FFFFFF').font('M-Bold').text('ATTENDANCE & REVENUE', M, 20);

const sections = [
  { icon: 'BarChart3', title: 'Attendance',      sub: 'Total visits, per-coach attendance, group fill rates' },
  { icon: 'TrendingUp', title: 'Revenue',        sub: 'Monthly revenue, QAR per session, coach compensation' },
  { icon: 'User',       title: 'Coach Overview', sub: 'Session counts, performance metrics, feedback scores' },
];

sections.forEach((sec, i) => {
  const sy = 72 + i * 220;
  doc.fontSize(13).fillColor(BLUE).font('M-ExtraBold');
  const iw2 = icons.draw(doc, sec.icon, M, sy + 1, { size: 16, color: BLUE });
  doc.text(sec.title, M + iw2, sy);

  // Placeholder box
  doc.rect(M, sy + 22, W - M * 2, 160).fill('#F8F9FA').roundedRect(M, sy + 22, W - M * 2, 160, 8).fill('#F8F9FA');
  doc.rect(M, sy + 22, W - M * 2, 160).roundedRect(M, sy + 22, W - M * 2, 160, 8)
     .lineWidth(1).strokeColor('#E5E5E5').stroke();

  icons.draw(doc, 'Package', W / 2 - 20, sy + 60, { size: 40, color: '#CCCCCC' });
  doc.fontSize(12).fillColor('#AAAAAA').font('M-SemiBold')
     .text('Coming with in2 integration', 0, sy + 108, { align: 'center', width: W });
  doc.fontSize(9).fillColor('#BBBBBB').font('M-Regular')
     .text(sec.sub, 0, sy + 126, { align: 'center', width: W });
  doc.fontSize(8).fillColor('#CCCCCC').font('M-Light')
     .text('Expected: August 2026', 0, sy + 144, { align: 'center', width: W });
});

doc.rect(0, H - 40, W, 40).fill('#F8F9FA');
doc.fontSize(8).fillColor(GREY).font('M-Regular').text('AcroGym Doha · Confidential', M, H - 26);
doc.fontSize(8).fillColor(GREY).font('M-Regular').text('Page 4 of 4', 0, H - 26, { align: 'right', width: W - M });

doc.end();
console.log('font-test-v2.pdf written to /tmp/');
