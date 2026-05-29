'use strict';

/**
 * scripts/test-pdf.js — Regression test for pdf-exporter after report-data refactor.
 * Generates EN and RU monthly PDFs and saves to /tmp/.
 */

const fs  = require('fs');
const { generatePdf } = require('../agents/owner-bot/exporters/pdf-exporter');

const OPTS = {
  period:   'month',
  dateFrom: '2026-05-01',
  dateTo:   '2026-05-27',
};

(async () => {
  console.log('Generating EN PDF...');
  const t0 = Date.now();
  const enBuf = await generatePdf({ ...OPTS, lang: 'en' });
  console.log(`  EN done in ${Date.now() - t0}ms — ${enBuf.length} bytes`);
  fs.writeFileSync('/tmp/pdf-after-refactor-en.pdf', enBuf);

  console.log('Generating RU PDF...');
  const t1 = Date.now();
  const ruBuf = await generatePdf({ ...OPTS, lang: 'ru' });
  console.log(`  RU done in ${Date.now() - t1}ms — ${ruBuf.length} bytes`);
  fs.writeFileSync('/tmp/pdf-after-refactor-ru.pdf', ruBuf);

  console.log('\nFiles written:');
  console.log('  /tmp/pdf-after-refactor-en.pdf —', enBuf.length, 'bytes');
  console.log('  /tmp/pdf-after-refactor-ru.pdf —', ruBuf.length, 'bytes');
  console.log('\nDone ✅');
})().catch(err => { console.error('FAILED:', err); process.exit(1); });
