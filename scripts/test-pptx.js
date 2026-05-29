'use strict';

/**
 * scripts/test-pptx.js — smoke test for premium PPTX exporter.
 * Generates EN + RU monthly PPTX (period: 2026-05-01 to 2026-05-27,
 * relies on seed test data — 38 leads).
 *
 * Output:
 *   exports/pptx-final-en.pptx
 *   exports/pptx-final-ru.pptx
 */

const fs   = require('fs');
const path = require('path');
const { generatePptx } = require('../agents/owner-bot/exporters/pptx-exporter');

const OPTS = {
  period:   'month',
  dateFrom: '2026-05-01',
  dateTo:   '2026-05-27',
};

(async () => {
  const outDir = path.join(__dirname, '../exports');

  console.log('Generating EN PPTX...');
  const t0    = Date.now();
  const enBuf = await generatePptx({ ...OPTS, lang: 'en' });
  console.log(`  EN done in ${Date.now() - t0}ms — ${enBuf.length} bytes`);

  console.log('Generating RU PPTX...');
  const t1    = Date.now();
  const ruBuf = await generatePptx({ ...OPTS, lang: 'ru' });
  console.log(`  RU done in ${Date.now() - t1}ms — ${ruBuf.length} bytes`);

  const enPath = path.join(outDir, 'pptx-final-en.pptx');
  const ruPath = path.join(outDir, 'pptx-final-ru.pptx');

  fs.writeFileSync(enPath, enBuf);
  fs.writeFileSync(ruPath, ruBuf);

  console.log('\nFiles written:');
  console.log(' ', enPath, '—', enBuf.length, 'bytes');
  console.log(' ', ruPath, '—', ruBuf.length, 'bytes');
  console.log('\nDone ✅');
})().catch(err => { console.error('FAILED:', err); process.exit(1); });
