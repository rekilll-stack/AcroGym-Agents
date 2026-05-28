'use strict';
/**
 * font-test-v4.js — правки 1-4:
 *   1. Cover: "Generated" текст ярче (#E0E0FF / opacity 0.85)
 *   2. Exec Summary: цветные точки перед статусами, отступ между блоками
 *   3. Key Events: оранжевые акцентные полоски (#F37021, 3×16pt)
 *   4. Leads: pie chart + line chart через shared/chart.js
 *
 * Run: node font-test-v4.js
 */

const PDFDocument = require('pdfkit');
const fs          = require('fs');
const icons       = require('./shared/pdf-icons');
const { renderPieChart, renderLineChart } = require('./shared/chart');

const FONT  = '/usr/share/fonts/truetype/montserrat/';
const BLUE  = '#28347F';
const ORANGE= '#F37021';
const GREY  = '#666666';
const DARK  = '#1A1A2E';
const WHITE = '#FFFFFF';
const LIGHT = '#F8F9FA';
const PAGE  = { size: 'A4', margin: 0 };

// ── Fix 1: ZWNJ lигатура ────────────────────────────────────
function noLig(str) {
  return String(str == null ? '' : str)
    .replace(/fi/g, 'f‌i')
    .replace(/fl/g, 'f‌l')
    .replace(/ff/g, 'f‌f');
}

// ── Helpers ──────────────────────────────────────────────────
const doc = new PDFDocument({ size: 'A4', margin: 0 });
doc.registerFont('M-Black',    FONT + 'Montserrat-Black.ttf');
doc.registerFont('M-ExtraBold',FONT + 'Montserrat-ExtraBold.ttf');
doc.registerFont('M-Bold',     FONT + 'Montserrat-Bold.ttf');
doc.registerFont('M-SemiBold', FONT + 'Montserrat-SemiBold.ttf');
doc.registerFont('M-Regular',  FONT + 'Montserrat-Regular.ttf');
doc.registerFont('M-Light',    FONT + 'Montserrat-Light.ttf');
doc.pipe(fs.createWriteStream('/tmp/font-test-v5.pdf'));

const W = doc.page.width;
const H = doc.page.height;
const M = 40;

function txt(text, x, y, opts = {}) {
  doc.text(noLig(text), x, y, { lineBreak: false, ...opts });
}
function par(text, x, y, opts = {}) {
  doc.text(noLig(text), x, y, opts);
}
function footer(pageNum, total) {
  doc.rect(0, H - 44, W, 44).fill(LIGHT);
  doc.moveTo(M, H - 44).lineTo(W - M, H - 44).lineWidth(0.5).strokeColor('#E0E0E0').stroke();
  doc.fontSize(7.5).fillColor(GREY).font('M-Regular');
  txt(noLig('AcroGym · Monthly Report'), M, H - 28);
  txt(`Page ${pageNum} of ${total}`, W - M - 60, H - 28);
}

// ═══════════════════════════════════════════════════════════
// PAGE 1 — COVER (правка 1: "Generated" текст ярче)
// ═══════════════════════════════════════════════════════════
doc.rect(0, 0, W, H).fill(BLUE);

try {
  doc.image('./config/brand/logo-white.png', W / 2 - 60, 130, { width: 120 });
} catch {
  doc.fontSize(54).fillColor(WHITE).font('M-Black');
  txt('AcroGym', 0, 140, { width: W, align: 'center' });
}

doc.fontSize(26).fillColor(WHITE).font('M-ExtraBold');
txt('MONTHLY REPORT', 0, 300, { width: W, align: 'center' });

doc.fontSize(15).fillColor('rgba(255,255,255,0.75)').font('M-Regular');
txt('May 2026', 0, 338, { width: W, align: 'center' });

doc.moveTo(80, 374).lineTo(W - 80, 374).lineWidth(0.5).strokeColor('rgba(255,255,255,0.3)').stroke();

// ── Правка 1: было opacity 0.5 → теперь цвет #E0E0FF (читаемо, не кричит)
doc.fontSize(10).fillColor('#E0E0FF').font('M-Light');
txt(noLig('Generated 2026-05-27'), 0, 390, { width: W, align: 'center' });

// ═══════════════════════════════════════════════════════════
// PAGE 2 — EXECUTIVE SUMMARY (правки 2 + 3)
// ═══════════════════════════════════════════════════════════
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
  { label: 'NEW LEADS',      value: '38', sub: '+12% vs Apr', real: true  },
  { label: 'REVENUE (QAR)',  value: '—',  sub: 'in2 pending', real: false },
  { label: 'ACTIVE MEMBERS', value: '—',  sub: 'in2 pending', real: false },
];

COLS.forEach((col, i) => {
  const cx = M + i * colW;
  doc.fontSize(col.real ? 54 : 32).fillColor(col.real ? ORANGE : '#C8C8C8').font('M-Black');
  txt(col.value, cx, 68, { width: colW, align: 'center' });
  doc.fontSize(8).fillColor(GREY).font('M-Bold');
  txt(col.label, cx, 138, { width: colW, align: 'center' });
  doc.fontSize(7.5).fillColor(col.real ? '#16A34A' : '#C8C8C8').font('M-Regular');
  txt(noLig(col.sub), cx, 152, { width: colW, align: 'center' });
  if (i < 2) {
    doc.moveTo(M + (i + 1) * colW, 62).lineTo(M + (i + 1) * colW, 170)
       .lineWidth(0.5).strokeColor('#E5E5E5').stroke();
  }
});

// ── Правка 2: отступ 20pt между блоками, цветные точки ──
const STATUS_Y = 192;   // было 182 → +10pt

doc.rect(M, STATUS_Y, W - M * 2, 92).fill(LIGHT)
   .roundedRect(M, STATUS_Y, W - M * 2, 92, 5).fill(LIGHT);

const STATUSES = [
  { fill: '#DC2626', line: noLig('Revenue: behind target (in2 data pending)')     },
  { fill: '#F59E0B', line: noLig('Leads: on pace (38 this month, target 40)')     },
  { fill: '#DC2626', line: noLig('Response: behind target (avg 4.2h, goal ≤ 2h)') },
];

STATUSES.forEach((s, i) => {
  const sy = STATUS_Y + 14 + i * 24;
  // ── Правка 2: цветная точка вместо icon.draw status_* ──
  doc.circle(M + 20, sy + 6, 5).fill(s.fill);
  doc.fontSize(9.5).fillColor(DARK).font('M-SemiBold');
  txt(s.line, M + 32, sy + 1);
});

// ── Key Events (правка 3: оранжевые полоски слева) ──
const KE_Y = STATUS_Y + 108;   // ниже статус-блока
doc.fontSize(12).fillColor(BLUE).font('M-ExtraBold');
txt('Key Events', M, KE_Y);

const EVENTS = [
  { icon: 'TrendingUp',    color: '#16A34A', text: noLig('38 new leads in May — highest since February')           },
  { icon: 'Package',       color: ORANGE,    text: noLig('Revenue & attendance data pending in2 (Aug 2026)')        },
  { icon: 'AlertTriangle', color: '#DC2626', text: noLig('Avg first-response 4.2h — target ≤ 2h not met')          },
];

EVENTS.forEach((ev, i) => {
  const ey = KE_Y + 22 + i * 32;
  // ── Правка 3: оранжевая полоска (#F37021, 3×16pt) ──
  doc.rect(M, ey + 3, 3, 16).fill(ORANGE);
  const iw = icons.draw(doc, ev.icon, M + 10, ey + 4, { size: 13, color: ev.color });
  doc.fontSize(9.5).fillColor(DARK).font('M-Regular');
  par(ev.text, M + 10 + iw, ey + 5, { width: W - M * 2 - 30 });
});

footer(2, 4);

// ═══════════════════════════════════════════════════════════
// PAGE 3 — LEADS & PIPELINE (правка 4: два графика)
// ═══════════════════════════════════════════════════════════
doc.addPage(PAGE);
doc.rect(0, 0, W, H).fill(WHITE);

// Header
doc.rect(0, 0, W, 52).fill(BLUE);
doc.fontSize(12).fillColor(WHITE).font('M-Bold');
txt('LEADS & PIPELINE', M, 19);
doc.fontSize(9).fillColor('rgba(255,255,255,0.65)').font('M-Regular');
txt('May 2026', W - M - 45, 21);

// ── Conversion Funnel ──
doc.fontSize(11).fillColor(BLUE).font('M-ExtraBold');
txt('Conversion Funnel', M, 66);

const FUNNEL = [
  { stage: 'Submitted',      count: '38', pct: '100%', real: true  },
  { stage: 'Responded',      count: '31', pct:  '82%', real: true  },
  { stage: 'Trial Booked',   count:  '—', pct:   '—',  real: false },
  { stage: 'Trial Attended', count:  '—', pct:   '—',  real: false },
  { stage: 'Subscribed',     count:  '—', pct:   '—',  real: false },
];

FUNNEL.forEach((row, i) => {
  const ry = 84 + i * 24;
  if (i % 2 === 0) doc.rect(M, ry, W - M * 2, 23).fill(LIGHT);
  doc.fontSize(9).fillColor(row.real ? DARK : '#BBBBBB').font('M-Regular');
  txt(row.stage, M + 8, ry + 6);
  doc.fontSize(12).fillColor(row.real ? BLUE : '#CCCCCC').font('M-Bold');
  txt(row.count, 0, ry + 4, { width: W - M - 80, align: 'right' });
  doc.fontSize(8).fillColor(row.real ? GREY : '#DDDDDD').font('M-Regular');
  txt(row.pct, 0, ry + 7, { width: W - M - 8, align: 'right' });
});

// ── in2 placeholder ──
const PH_Y = 84 + FUNNEL.length * 24 + 8;
doc.rect(M, PH_Y, W - M * 2, 54).fill('#FFF8F0')
   .roundedRect(M, PH_Y, W - M * 2, 54, 5).fill('#FFF8F0');
doc.rect(M, PH_Y, 4, 54).fill(ORANGE);
const piw = icons.draw(doc, 'Package', M + 14, PH_Y + 10, { size: 15, color: ORANGE });
doc.fontSize(10).fillColor(ORANGE).font('M-Bold');
txt(noLig('Coming with in2 integration'), M + 14 + piw, PH_Y + 11);
doc.fontSize(8).fillColor(GREY).font('M-Regular');
par(noLig('Trial bookings, attendance tracking, subscriptions and revenue after in2 API (Aug 2026).'),
    M + 14 + piw, PH_Y + 26, { width: W - M * 2 - 50 });

// ── Правка 4A: PIE CHART источников ──────────────────────────
const CHART_Y = PH_Y + 66;

// Mock source data (в продакшене — из БД)
const SRC_LABELS = ['Instagram', 'Website', 'Referral', 'Other'];
const SRC_COUNTS = [22, 9, 5, 2];  // итого 38
const SRC_COLORS = ['#28347F', '#F37021', '#5A6BC4', '#FF9755'];
const SRC_TOTAL  = SRC_COUNTS.reduce((a, b) => a + b, 0);

// Текст-заголовок
doc.fontSize(11).fillColor(BLUE).font('M-ExtraBold');
txt(noLig('Lead Sources Distribution'), M, CHART_Y);

// Рендерим pie chart в PNG → вставляем в PDF
// Делаем через Promise, но т.к. у нас sync контекст — откладываем finish
let pdfFinished = false;
let pieBuffer, lineBuffer;

const PIE_SIZE  = 220;    // px → отображается как pt в PDF
const PIE_PDF_W = 175;    // ширина в PDF (pt)
const LINE_PDF_W = W - M * 2;
const LINE_PDF_H = 150;

// Источники — текстовая таблица справа от pie
const TABLE_X = M + PIE_PDF_W + 16;
const TABLE_W = W - TABLE_X - M;

async function buildAndFinalize() {
  // ─── PIE CHART ───────────────────────────────────────────
  pieBuffer = await renderPieChart({
    title:   '',           // заголовок уже нарисован текстом выше
    labels:  SRC_LABELS,
    data:    SRC_COUNTS,
    width:   PIE_SIZE,
    height:  PIE_SIZE,
    doughnut: false,
  });

  const PIE_Y = CHART_Y + 16;
  doc.image(pieBuffer, M, PIE_Y, { width: PIE_PDF_W });

  // Таблица с абсолютными числами справа от пирога
  doc.fontSize(9).fillColor(GREY).font('M-Bold');
  txt('Source', TABLE_X, PIE_Y + 4);
  txt('Leads', TABLE_X + TABLE_W - 60, PIE_Y + 4);
  txt('%', TABLE_X + TABLE_W - 20, PIE_Y + 4);
  doc.moveTo(TABLE_X, PIE_Y + 16).lineTo(TABLE_X + TABLE_W, PIE_Y + 16)
     .lineWidth(0.5).strokeColor('#DDDDDD').stroke();

  SRC_LABELS.forEach((lbl, i) => {
    const ty = PIE_Y + 24 + i * 22;
    // Цветная точка
    doc.circle(TABLE_X + 6, ty + 6, 4).fill(SRC_COLORS[i]);
    doc.fontSize(9).fillColor(DARK).font('M-Regular');
    txt(lbl, TABLE_X + 16, ty + 2);
    doc.font('M-Bold');
    txt(String(SRC_COUNTS[i]), TABLE_X + TABLE_W - 60, ty + 2);
    doc.font('M-Regular').fillColor(GREY);
    txt(`${Math.round(SRC_COUNTS[i] / SRC_TOTAL * 100)}%`, TABLE_X + TABLE_W - 20, ty + 2);
  });

  // ─── LINE CHART трендов ───────────────────────────────────
  // Mock 28-дневный ряд (в продакшене — из БД)
  const today = new Date('2026-05-27');
  const lineLabels = [];
  const lineData   = [];
  for (let d = 27; d >= 0; d--) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - d);
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    lineLabels.push(`${mm}/${dd}`);
    // синтетические данные с реалистичным паттерном
    const base = 1 + Math.floor(Math.random() * 4);
    const bump = (dt.getDay() === 6) ? 4 : (dt.getDay() === 0) ? 2 : 0; // суббота/воскресенье
    lineData.push(base + bump);
  }
  // Зафиксируем финальные значения чтобы total ≈ 38
  // (просто для теста — в проде будут реальные)

  // Best / Worst insight — считаем ДО рендера, вставляем в подзаголовок (без overlap)
  const maxIdx = lineData.indexOf(Math.max(...lineData));
  const minIdx = lineData.indexOf(Math.min(...lineData));
  const insightStr = noLig(
    `Best: ${lineLabels[maxIdx]} (${lineData[maxIdx]} leads)  ·  Worst: ${lineLabels[minIdx]} (${lineData[minIdx]} lead${lineData[minIdx] !== 1 ? 's' : ''})`
  );

  lineBuffer = await renderLineChart({
    title:  noLig('Daily Leads — Last 4 Weeks'),
    labels: lineLabels,
    data:   lineData,
    width:  960,
    height: 320,
  });

  const LINE_Y = CHART_Y + 16 + PIE_PDF_W + 14;  // под pie chart

  // Заголовок (жирный) + insight-хвост (regular, grey) в одной строке над графиком
  doc.fontSize(11).fillColor(BLUE).font('M-ExtraBold');
  txt(noLig('Daily Leads — Last 4 Weeks'), M, LINE_Y);
  const headW = doc.widthOfString(noLig('Daily Leads — Last 4 Weeks'));
  doc.fontSize(8.5).fillColor(GREY).font('M-Regular');
  txt(`  ·  ${insightStr}`, M + headW, LINE_Y + 1.5);

  // График — сразу под заголовком, insight-строки под ним нет
  doc.image(lineBuffer, M, LINE_Y + 18, { width: LINE_PDF_W });

  footer(3, 4);

  // ═══════════════════════════════════════════════════════════
  // PAGE 4 — PLACEHOLDERS
  // ═══════════════════════════════════════════════════════════
  doc.addPage(PAGE);
  doc.rect(0, 0, W, H).fill(WHITE);

  doc.rect(0, 0, W, 52).fill(BLUE);
  doc.fontSize(12).fillColor(WHITE).font('M-Bold');
  txt('ATTENDANCE, REVENUE & COACHES', M, 19);
  doc.fontSize(9).fillColor('rgba(255,255,255,0.65)').font('M-Regular');
  txt('May 2026', W - M - 45, 21);

  const PH_SECS = [
    { icon: 'BarChart3',  title: 'Attendance',    sub: noLig('Total visits, per-coach attendance, group fi'+'ll rates') },
    { icon: 'TrendingUp', title: 'Revenue',       sub: noLig('Monthly revenue, QAR per session, coach compensation')   },
    { icon: 'User',       title: 'Coach Overview',sub: noLig('Session counts, performance metrics, feedback scores')   },
  ];

  const SEC_H = 218;
  PH_SECS.forEach((sec, i) => {
    const sy = 62 + i * SEC_H;
    const iw2 = icons.draw(doc, sec.icon, M, sy + 2, { size: 15, color: BLUE });
    doc.fontSize(12).fillColor(BLUE).font('M-ExtraBold');
    txt(sec.title, M + iw2, sy);

    const bx = M, by = sy + 22, bw = W - M * 2, bh = 172;
    doc.rect(bx, by, bw, bh).fill(LIGHT)
       .roundedRect(bx, by, bw, bh, 8).fill(LIGHT);
    doc.roundedRect(bx, by, bw, bh, 8).lineWidth(1).strokeColor('#E0E0E0').stroke();

    icons.draw(doc, 'Package', W / 2 - 22, by + 40, { size: 44, color: '#CCCCCC' });

    doc.fontSize(12).fillColor('#AAAAAA').font('M-SemiBold');
    txt(noLig('Coming with in2 integration'), 0, by + 96, { width: W, align: 'center' });
    doc.fontSize(8.5).fillColor('#BBBBBB').font('M-Regular');
    txt(sec.sub, 0, by + 114, { width: W, align: 'center' });
    doc.fontSize(8).fillColor('#CCCCCC').font('M-Light');
    txt('Expected: August 2026', 0, by + 132, { width: W, align: 'center' });
  });

  footer(4, 4);

  doc.end();
  console.log('font-test-v5.pdf → /tmp/font-test-v5.pdf');
}

buildAndFinalize().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
