'use strict';

/**
 * scripts/test-empty-period.js
 * Generate 8 + 4 files for visual diff: March (empty) vs May (38 leads).
 *
 * Output naming (avoid collision with libreoffice PPTX→PDF conversion):
 *   final-{tag}-{lang}.pdf       — native PDF from pdf-exporter
 *   final-{tag}-{lang}.pptx      — native PPTX from pptx-exporter
 *   pptx-preview-{tag}-{lang}.pdf — libreoffice-converted PPTX preview
 */

const fs   = require('fs');
const path = require('path');
const { generatePdf }  = require('../agents/owner-bot/exporters/pdf-exporter');
const { generatePptx } = require('../agents/owner-bot/exporters/pptx-exporter');

const EXPORTS = path.join(__dirname, '../exports');

const PERIODS = [
  { tag: 'march', dateFrom: '2026-03-01', dateTo: '2026-03-31' },
  { tag: 'may',   dateFrom: '2026-05-01', dateTo: '2026-05-29' },
];

(async () => {
  for (const p of PERIODS) {
    for (const lang of ['en', 'ru']) {
      console.log(`Generating ${p.tag} ${lang.toUpperCase()}...`);
      const opts = { period: 'month', lang, dateFrom: p.dateFrom, dateTo: p.dateTo };

      const pdfBuf  = await generatePdf(opts);
      const pdfPath = path.join(EXPORTS, `final-${p.tag}-${lang}.pdf`);
      fs.writeFileSync(pdfPath, pdfBuf);
      console.log(`  ${path.basename(pdfPath)} — ${pdfBuf.length} bytes`);

      const pptxBuf  = await generatePptx(opts);
      const pptxPath = path.join(EXPORTS, `final-${p.tag}-${lang}.pptx`);
      fs.writeFileSync(pptxPath, pptxBuf);
      console.log(`  ${path.basename(pptxPath)} — ${pptxBuf.length} bytes`);
    }
  }

  console.log('\nDone ✅');
})().catch(err => { console.error('FAILED:', err); process.exit(1); });
