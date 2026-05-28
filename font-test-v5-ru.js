'use strict';
/**
 * font-test-v5-ru.js — RU версия финального дизайна PDF
 * Тестовый скрипт (захардкожен RU). Production PDF будет через pdf-exporter.js + i18n.
 * Run: node font-test-v5-ru.js
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

// Fix: ZWNJ — разбиваем лигатуры fi/fl/ff
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
doc.pipe(fs.createWriteStream('/tmp/font-test-v5-ru.pdf'));

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
  txt('AcroGym · Месячный отчёт', M, H - 28);
  txt(`Стр. ${pageNum} из ${total}`, W - M - 70, H - 28);
}

// ═══════════════════════════════════════════════════════════
// PAGE 1 — ОБЛОЖКА
// ═══════════════════════════════════════════════════════════
doc.rect(0, 0, W, H).fill(BLUE);

try {
  doc.image('./config/brand/logo-white.png', W / 2 - 60, 130, { width: 120 });
} catch {
  doc.fontSize(54).fillColor(WHITE).font('M-Black');
  txt('AcroGym', 0, 140, { width: W, align: 'center' });
}

doc.fontSize(26).fillColor(WHITE).font('M-ExtraBold');
txt('ЕЖЕМЕСЯЧНЫЙ ОТЧЁТ', 0, 300, { width: W, align: 'center' });

doc.fontSize(15).fillColor('rgba(255,255,255,0.75)').font('M-Regular');
txt('Май 2026', 0, 338, { width: W, align: 'center' });

doc.moveTo(80, 374).lineTo(W - 80, 374).lineWidth(0.5).strokeColor('rgba(255,255,255,0.3)').stroke();

doc.fontSize(10).fillColor('#E0E0FF').font('M-Light');
txt('Сформировано 27.05.2026', 0, 390, { width: W, align: 'center' });

// ═══════════════════════════════════════════════════════════
// PAGE 2 — ИТОГИ МЕСЯЦА
// ═══════════════════════════════════════════════════════════
doc.addPage(PAGE);
doc.rect(0, 0, W, H).fill(WHITE);

// Полоса заголовка
doc.rect(0, 0, W, 52).fill(BLUE);
doc.fontSize(12).fillColor(WHITE).font('M-Bold');
txt('ИТОГИ МЕСЯЦА', M, 19);
doc.fontSize(9).fillColor('rgba(255,255,255,0.65)').font('M-Regular');
txt('Май 2026', W - M - 55, 21);

// ── Три ключевых показателя ──
const colW = (W - M * 2) / 3;
const COLS = [
  { label: 'НОВЫЕ ЛИДЫ',      value: '38', sub: '+12% к апрелю', real: true  },
  { label: 'ВЫРУЧКА (QAR)',   value: '—',  sub: 'ожидает in2',   real: false },
  { label: 'АКТИВНЫХ ЧЛЕНОВ', value: '—',  sub: 'ожидает in2',   real: false },
];

COLS.forEach((col, i) => {
  const cx = M + i * colW;
  doc.fontSize(col.real ? 54 : 32).fillColor(col.real ? ORANGE : '#C8C8C8').font('M-Black');
  txt(col.value, cx, 68, { width: colW, align: 'center' });
  doc.fontSize(8).fillColor(GREY).font('M-Bold');
  txt(col.label, cx, 138, { width: colW, align: 'center' });
  doc.fontSize(7.5).fillColor(col.real ? '#16A34A' : '#C8C8C8').font('M-Regular');
  txt(col.sub, cx, 152, { width: colW, align: 'center' });
  if (i < 2) {
    doc.moveTo(M + (i + 1) * colW, 62).lineTo(M + (i + 1) * colW, 170)
       .lineWidth(0.5).strokeColor('#E5E5E5').stroke();
  }
});

// ── Статусы ──
const STATUS_Y = 192;

doc.rect(M, STATUS_Y, W - M * 2, 92).fill(LIGHT)
   .roundedRect(M, STATUS_Y, W - M * 2, 92, 5).fill(LIGHT);

const STATUSES = [
  { fill: '#DC2626', line: 'Выручка: ниже плана (данные in2 ожидаются)'         },
  { fill: '#F59E0B', line: 'Лиды: в рамках плана (38 за месяц, цель 40)'        },
  { fill: '#DC2626', line: 'Отклик: ниже цели (ср. 4,2 ч, цель ≤ 2 ч)'         },
];

STATUSES.forEach((s, i) => {
  const sy = STATUS_Y + 14 + i * 24;
  doc.circle(M + 20, sy + 6, 5).fill(s.fill);
  doc.fontSize(9.5).fillColor(DARK).font('M-SemiBold');
  txt(s.line, M + 32, sy + 1);
});

// ── Ключевые события ──
const KE_Y = STATUS_Y + 108;
doc.fontSize(12).fillColor(BLUE).font('M-ExtraBold');
txt('Ключевые события', M, KE_Y);

const EVENTS = [
  { icon: 'TrendingUp',    color: '#16A34A', text: '38 новых лидов в мае — максимум с февраля'           },
  { icon: 'Package',       color: ORANGE,    text: noLig('Выручка и посещаемость ожидают in2 (авг. 2026)')        },
  { icon: 'AlertTriangle', color: '#DC2626', text: noLig('Ср. время первого ответа 4,2 ч — цель ≤ 2 ч не достигнута') },
];

EVENTS.forEach((ev, i) => {
  const ey = KE_Y + 22 + i * 32;
  doc.rect(M, ey + 3, 3, 16).fill(ORANGE);
  const iw = icons.draw(doc, ev.icon, M + 10, ey + 4, { size: 13, color: ev.color });
  doc.fontSize(9.5).fillColor(DARK).font('M-Regular');
  par(ev.text, M + 10 + iw, ey + 5, { width: W - M * 2 - 30 });
});

footer(2, 4);

// ═══════════════════════════════════════════════════════════
// PAGE 3 — ЛИДЫ И ВОРОНКА
// ═══════════════════════════════════════════════════════════
doc.addPage(PAGE);
doc.rect(0, 0, W, H).fill(WHITE);

doc.rect(0, 0, W, 52).fill(BLUE);
doc.fontSize(12).fillColor(WHITE).font('M-Bold');
txt('ЛИДЫ И ВОРОНКА ПРОДАЖ', M, 19);
doc.fontSize(9).fillColor('rgba(255,255,255,0.65)').font('M-Regular');
txt('Май 2026', W - M - 55, 21);

// ── Воронка конверсии ──
doc.fontSize(11).fillColor(BLUE).font('M-ExtraBold');
txt('Воронка конверсии', M, 66);

const FUNNEL = [
  { stage: 'Подано заявок',       count: '38', pct: '100%', real: true  },
  { stage: 'Получили ответ',      count: '31', pct:  '82%', real: true  },
  { stage: 'Записались на пробу', count:  '—', pct:   '—',  real: false },
  { stage: 'Пришли на пробу',     count:  '—', pct:   '—',  real: false },
  { stage: 'Оформили абонемент',  count:  '—', pct:   '—',  real: false },
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

// ── Блок in2 ──
const PH_Y = 84 + FUNNEL.length * 24 + 8;
doc.rect(M, PH_Y, W - M * 2, 54).fill('#FFF8F0')
   .roundedRect(M, PH_Y, W - M * 2, 54, 5).fill('#FFF8F0');
doc.rect(M, PH_Y, 4, 54).fill(ORANGE);
const piw = icons.draw(doc, 'Package', M + 14, PH_Y + 10, { size: 15, color: ORANGE });
doc.fontSize(10).fillColor(ORANGE).font('M-Bold');
txt('Появится с интеграцией in2', M + 14 + piw, PH_Y + 11);
doc.fontSize(8).fillColor(GREY).font('M-Regular');
par('Бронирование пробных, посещаемость, конверсии в абонемент и выручка\nзаполнятся автоматически после запуска in2 API (август 2026).',
    M + 14 + piw, PH_Y + 26, { width: W - M * 2 - 50 });

// ── Pie chart источников ──────────────────────────────────────
const CHART_Y = PH_Y + 66;

const SRC_LABELS = ['Instagram', 'Сайт', 'Рекомендации', 'Другое'];
const SRC_COUNTS = [22, 9, 5, 2];
const SRC_COLORS = ['#28347F', '#F37021', '#5A6BC4', '#FF9755'];
const SRC_TOTAL  = SRC_COUNTS.reduce((a, b) => a + b, 0);

doc.fontSize(11).fillColor(BLUE).font('M-ExtraBold');
txt('Распределение по источникам', M, CHART_Y);

let pieBuffer, lineBuffer;

const PIE_SIZE  = 220;
const PIE_PDF_W = 175;
const LINE_PDF_W = W - M * 2;

const TABLE_X = M + PIE_PDF_W + 16;
const TABLE_W = W - TABLE_X - M;

async function buildAndFinalize() {
  // ─── PIE CHART ────────────────────────────────────────────
  pieBuffer = await renderPieChart({
    title:   '',
    labels:  SRC_LABELS,
    data:    SRC_COUNTS,
    width:   PIE_SIZE,
    height:  PIE_SIZE,
    doughnut: false,
  });

  const PIE_Y = CHART_Y + 16;
  doc.image(pieBuffer, M, PIE_Y, { width: PIE_PDF_W });

  // Таблица источников
  doc.fontSize(9).fillColor(GREY).font('M-Bold');
  txt('Источник', TABLE_X, PIE_Y + 4);
  txt('Лиды', TABLE_X + TABLE_W - 60, PIE_Y + 4);
  txt('%', TABLE_X + TABLE_W - 20, PIE_Y + 4);
  doc.moveTo(TABLE_X, PIE_Y + 16).lineTo(TABLE_X + TABLE_W, PIE_Y + 16)
     .lineWidth(0.5).strokeColor('#DDDDDD').stroke();

  SRC_LABELS.forEach((lbl, i) => {
    const ty = PIE_Y + 24 + i * 22;
    doc.circle(TABLE_X + 6, ty + 6, 4).fill(SRC_COLORS[i]);
    doc.fontSize(9).fillColor(DARK).font('M-Regular');
    txt(lbl, TABLE_X + 16, ty + 2);
    doc.font('M-Bold');
    txt(String(SRC_COUNTS[i]), TABLE_X + TABLE_W - 60, ty + 2);
    doc.font('M-Regular').fillColor(GREY);
    txt(`${Math.round(SRC_COUNTS[i] / SRC_TOTAL * 100)}%`, TABLE_X + TABLE_W - 20, ty + 2);
  });

  // ─── LINE CHART динамики ──────────────────────────────────
  const today = new Date('2026-05-27');
  const lineLabels = [];
  const lineData   = [];
  for (let d = 27; d >= 0; d--) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - d);
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    lineLabels.push(`${dd}.${mm}`);
    const base = 1 + Math.floor(Math.random() * 4);
    const bump = (dt.getDay() === 6) ? 4 : (dt.getDay() === 0) ? 2 : 0;
    lineData.push(base + bump);
  }

  const maxIdx = lineData.indexOf(Math.max(...lineData));
  const minIdx = lineData.indexOf(Math.min(...lineData));
  const insightStr = noLig(
    `Лучший: ${lineLabels[maxIdx]} (${lineData[maxIdx]} лидов)  ·  Худший: ${lineLabels[minIdx]} (${lineData[minIdx]} лид${
      lineData[minIdx] === 1 ? '' : lineData[minIdx] < 5 ? 'а' : 'ов'
    })`
  );

  lineBuffer = await renderLineChart({
    title:  'Лиды по дням — последние 4 недели',
    labels: lineLabels,
    data:   lineData,
    width:  960,
    height: 320,
  });

  const LINE_Y = CHART_Y + 16 + PIE_PDF_W + 14;

  doc.fontSize(11).fillColor(BLUE).font('M-ExtraBold');
  txt('Лиды по дням — последние 4 недели', M, LINE_Y);
  const headW = doc.widthOfString('Лиды по дням — последние 4 недели');
  doc.fontSize(8.5).fillColor(GREY).font('M-Regular');
  txt(`  ·  ${insightStr}`, M + headW, LINE_Y + 1.5);

  doc.image(lineBuffer, M, LINE_Y + 18, { width: LINE_PDF_W });

  footer(3, 4);

  // ═══════════════════════════════════════════════════════════
  // PAGE 4 — ЗАГЛУШКИ (посещаемость, выручка, тренеры)
  // ═══════════════════════════════════════════════════════════
  doc.addPage(PAGE);
  doc.rect(0, 0, W, H).fill(WHITE);

  doc.rect(0, 0, W, 52).fill(BLUE);
  doc.fontSize(12).fillColor(WHITE).font('M-Bold');
  txt('ПОСЕЩАЕМОСТЬ, ВЫРУЧКА И ТРЕНЕРЫ', M, 19);
  doc.fontSize(9).fillColor('rgba(255,255,255,0.65)').font('M-Regular');
  txt('Май 2026', W - M - 55, 21);

  const PH_SECS = [
    {
      icon:  'BarChart3',
      title: 'Посещаемость',
      sub:   noLig('Итого визитов, посещаемость по тренерам, заполняемость групп'),
    },
    {
      icon:  'TrendingUp',
      title: 'Выручка',
      sub:   noLig('Ежемесячная выручка, QAR за занятие, вознаграждение тренеров'),
    },
    {
      icon:  'User',
      title: 'Обзор тренеров',
      sub:   noLig('Кол-во занятий, показатели эффективности, оценки обратной связи'),
    },
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
    txt('Появится с интеграцией in2', 0, by + 96, { width: W, align: 'center' });
    doc.fontSize(8.5).fillColor('#BBBBBB').font('M-Regular');
    txt(sec.sub, 0, by + 114, { width: W, align: 'center' });
    doc.fontSize(8).fillColor('#CCCCCC').font('M-Light');
    txt('Ожидается: август 2026', 0, by + 132, { width: W, align: 'center' });
  });

  footer(4, 4);

  doc.end();
  console.log('✅ font-test-v5-ru.pdf → /tmp/font-test-v5-ru.pdf');
}

buildAndFinalize().catch(err => {
  console.error('❌ Build failed:', err);
  process.exit(1);
});
