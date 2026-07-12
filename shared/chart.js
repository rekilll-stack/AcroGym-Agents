'use strict';

/**
 * shared/chart.js — обёртка над chartjs-node-canvas.
 * Все графики рендерятся в фирменных цветах AcroGym.
 * Каждая функция возвращает Promise<Buffer> (PNG).
 *
 * Стайлинг 2026-07-12 (метод dataviz, палитра прогнана через валидатор):
 *  - категориальные цвета — ФИКСИРОВАННЫЙ порядок, не по кругу; серия из
 *    4 проверенных оттенков (CVD ≥ 12, контраст ≥ 3:1 на белом);
 *  - величина (bar по дням/часам) = ОДИН оттенок; тепловая карта = один
 *    оттенок светлый→тёмный (никаких радуг и прозрачностей);
 *  - сетка приглушена: только горизонтальные линии, без рамок;
 *  - подписи значений над столбцами (≤ 14 колонок) и на последней точке
 *    линии — текст ВСЕГДА в цвете текста, не серии;
 *  - пирог: белое 2px кольцо между долями + легенда (без легенды доли
 *    нечитаемы); заголовки — фирменный Gerhaus если шрифт доступен.
 */

const path = require('path');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { getBrand }          = require('./brand');

// ─── Brand font (Gerhaus) — регистрируется один раз, безопасно падает ───
let TITLE_FAMILY = 'sans-serif';
try {
  const { registerFont } = require('canvas');
  registerFont(path.join(__dirname, '../config/brand/fonts/Gerhaus-Regular.otf'), { family: 'Gerhaus' });
  TITLE_FAMILY = 'Gerhaus';
} catch (_) { /* шрифт не критичен */ }

// ─── Палитра ───
// series: категориальные слоты в фиксированном порядке (валидировано
// dataviz/scripts/validate_palette.js: lightness, chroma, CVD, contrast — PASS).
// text/grid — токены текста и сетки, НЕ цвета серий.
const DEFAULTS = {
  text:      '#28347F',
  textMuted: '#7A80A8',
  grid:      '#ECEDF4',
  surface:   '#FFFFFF',
  series:    ['#4656C0', '#E8650F', '#7B88DD', '#C0561B'],
  seq:       { from: '#E9EBF8', to: '#2E3C9E' }, // sequential: один оттенок, светлый→тёмный
};

function _palette() {
  const brand = (getBrand().chart_palette || {});
  return { ...DEFAULTS, ...brand };
}

function _canvas(width, height) {
  return new ChartJSNodeCanvas({ width, height, backgroundColour: 'white' });
}

function _titleOpts(palette, title) {
  return {
    display: !!title,
    text: title,
    color: palette.text,
    font: { size: 17, family: TITLE_FAMILY },
    padding: { bottom: 14 },
  };
}

// Приглушённая сетка: горизонтальные линии только, тонкие тики, без рамок.
function _recessiveScales(palette, { xTickSize = 11, rotate = 0 } = {}) {
  return {
    x: {
      grid:   { display: false },
      border: { color: palette.grid },
      ticks:  { color: palette.textMuted, font: { size: xTickSize }, maxRotation: rotate, minRotation: 0 },
    },
    y: {
      grid:   { color: palette.grid, drawTicks: false },
      border: { display: false },
      ticks:  { color: palette.textMuted, font: { size: 11 }, padding: 6, precision: 0 },
      beginAtZero: true,
    },
  };
}

function _hexToRgb(hex) {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

// Интерполяция одного оттенка light→dark для sequential-рамп.
function _seqColor(palette, t) {
  const a = _hexToRgb(palette.seq.from), b = _hexToRgb(palette.seq.to);
  const k = Math.max(0, Math.min(1, t));
  const c = (x, y) => Math.round(x + (y - x) * k);
  return `rgb(${c(a.r, b.r)},${c(a.g, b.g)},${c(a.b, b.b)})`;
}

// ─── Плагины ───

const WATERMARK_PLUGIN = {
  id: 'acrogym-watermark',
  afterDraw(chart) {
    const { ctx, width, height } = chart;
    ctx.save();
    ctx.globalAlpha  = 0.30;
    ctx.font         = `11px ${TITLE_FAMILY}`;
    ctx.fillStyle    = '#7A80A8';
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('AcroGym', width - 10, height - 8);
    ctx.restore();
  },
};

// Подписи значений над столбцами (только когда колонок немного — на плотных
// графиках это шум). Текст в цвете текста, не серии.
function barValueLabels(palette, { maxBars = 14 } = {}) {
  return {
    id: 'bar-value-labels',
    afterDatasetsDraw(chart) {
      const ds = chart.data.datasets;
      if (!ds.length || chart.data.labels.length > maxBars || ds.length > 2) return;
      const { ctx } = chart;
      ctx.save();
      ctx.font = '11px sans-serif';
      ctx.fillStyle = palette.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ds.forEach((d, di) => {
        const meta = chart.getDatasetMeta(di);
        meta.data.forEach((bar, i) => {
          const v = d.data[i];
          if (v == null || v === 0) return;
          ctx.fillText(String(v), bar.x, bar.y - 3);
        });
      });
      ctx.restore();
    },
  };
}

// Подпись значения на последней точке линии.
function lastPointLabel(palette) {
  return {
    id: 'last-point-label',
    afterDatasetsDraw(chart) {
      const d = chart.data.datasets[0];
      if (!d || !d.data.length) return;
      const meta = chart.getDatasetMeta(0);
      const pt = meta.data[meta.data.length - 1];
      if (!pt) return;
      const { ctx } = chart;
      ctx.save();
      ctx.font = 'bold 12px sans-serif';
      ctx.fillStyle = palette.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(String(d.data[d.data.length - 1]), pt.x, pt.y - 8);
      ctx.restore();
    },
  };
}

// ─────────────────────────────────────────────────────────────
// renderLineChart — динамика одной метрики (величина во времени)
// ─────────────────────────────────────────────────────────────

async function renderLineChart({ title, labels, data, width = 800, height = 400 }) {
  const palette = _palette();
  const canvas  = _canvas(width, height);
  const line    = palette.series[0];

  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: title,
        data,
        borderColor:          line,
        backgroundColor:      line + '24',
        pointBackgroundColor: line,
        pointBorderColor:     palette.surface, // 2px «кольцо поверхности» вокруг маркера
        pointBorderWidth:     2,
        borderWidth: 2,
        pointRadius: 4,
        fill: true,
        tension: 0.3,
      }],
    },
    options: {
      responsive: false,
      animation: false,
      layout: { padding: { top: 18, right: 22 } },
      plugins: {
        title:  _titleOpts(palette, title),
        legend: { display: false }, // одна серия — её называет заголовок
      },
      scales: _recessiveScales(palette),
    },
    plugins: [WATERMARK_PLUGIN, lastPointLabel(palette)],
  };

  return canvas.renderToBuffer(config);
}

// ─────────────────────────────────────────────────────────────
// renderBarChart — величина по категориям: ОДИН цвет, не радуга
// ─────────────────────────────────────────────────────────────

async function renderBarChart({ title, labels, data, width = 800, height = 400 }) {
  const palette = _palette();
  const canvas  = _canvas(width, height);

  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: title,
        data,
        backgroundColor: palette.series[0],
        borderRadius: { topLeft: 4, topRight: 4 },
        borderSkipped: 'bottom', // скругление только на «свободном» конце
        categoryPercentage: 0.72,
        barPercentage: 0.92,
      }],
    },
    options: {
      responsive: false,
      animation: false,
      layout: { padding: { top: 18 } },
      plugins: {
        title:  _titleOpts(palette, title),
        legend: { display: false },
      },
      scales: _recessiveScales(palette),
    },
    plugins: [WATERMARK_PLUGIN, barValueLabels(palette)],
  };

  return canvas.renderToBuffer(config);
}

// ─────────────────────────────────────────────────────────────
// renderHeatmap — активность по часам: sequential-рампа одного оттенка
// ─────────────────────────────────────────────────────────────

async function renderHeatmap({ title, data, width = 800, height = 400 }) {
  const palette = _palette();
  const canvas  = _canvas(width, height);
  const labels  = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}`);
  const max     = Math.max(...data, 1);

  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: title,
        data,
        backgroundColor: data.map(v => _seqColor(palette, v / max)),
        borderWidth: 0,
        borderRadius: { topLeft: 3, topRight: 3 },
        borderSkipped: 'bottom',
        categoryPercentage: 0.9,
        barPercentage: 0.94,
      }],
    },
    options: {
      responsive: false,
      animation: false,
      layout: { padding: { top: 14 } },
      plugins: {
        title:  _titleOpts(palette, title),
        legend: { display: false },
      },
      scales: _recessiveScales(palette, { xTickSize: 10 }),
    },
    plugins: [WATERMARK_PLUGIN],
  };

  return canvas.renderToBuffer(config);
}

// ─────────────────────────────────────────────────────────────
// renderWeeklyComparison — две недели: 2 категориальных цвета + легенда
// ─────────────────────────────────────────────────────────────

async function renderWeeklyComparison({ title, current_week, previous_week, labels, width = 800, height = 400 }) {
  const palette = _palette();
  const canvas  = _canvas(width, height);

  const bar = (label, data, color) => ({
    label, data,
    backgroundColor: color,
    borderRadius: { topLeft: 4, topRight: 4 },
    borderSkipped: 'bottom',
    categoryPercentage: 0.72,
    barPercentage: 0.9, // зазор между парными столбцами
  });

  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        bar('This week',     current_week,  palette.series[0]),
        bar('Previous week', previous_week, palette.series[1]),
      ],
    },
    options: {
      responsive: false,
      animation: false,
      layout: { padding: { top: 18 } },
      plugins: {
        title:  _titleOpts(palette, title),
        legend: {
          display: true,
          position: 'bottom',
          labels: { color: palette.text, boxWidth: 14, boxHeight: 14, padding: 16 },
        },
      },
      scales: _recessiveScales(palette),
    },
    plugins: [WATERMARK_PLUGIN, barValueLabels(palette)],
  };

  return canvas.renderToBuffer(config);
}

// ─────────────────────────────────────────────────────────────
// renderPieChart — доли: белое кольцо между секторами + ОБЯЗАТЕЛЬНАЯ легенда
// ─────────────────────────────────────────────────────────────

async function renderPieChart({ title, labels, data, width = 500, height = 500, doughnut = false }) {
  const palette = _palette();
  const canvas  = _canvas(width, height);

  const config = {
    type: doughnut ? 'doughnut' : 'pie',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: labels.map((_, i) => palette.series[i % palette.series.length]),
        borderColor: palette.surface,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: false,
      animation:  false,
      plugins: {
        title: _titleOpts(palette, title),
        legend: {
          display: true, // без легенды доли пирога нечитаемы
          position: 'bottom',
          labels: { color: palette.text, boxWidth: 14, boxHeight: 14, padding: 14 },
        },
      },
    },
    plugins: [WATERMARK_PLUGIN],
  };

  return canvas.renderToBuffer(config);
}

module.exports = { renderLineChart, renderBarChart, renderHeatmap, renderWeeklyComparison, renderPieChart };
