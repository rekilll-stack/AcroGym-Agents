const fs = require('fs');
const { chromium } = require('/home/admin/acrogym-design-system/.ds-sync/node_modules/playwright');
const [pdf, pageNo, out] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1000, height: 1400 } });
  await p.goto('about:blank');
  await p.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js' });
  const data = fs.readFileSync(pdf).toString('base64');
  await p.evaluate(async ({ data, pageNo }) => {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const bin = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const doc = await pdfjsLib.getDocument({ data: bin }).promise;
    const page = await doc.getPage(+pageNo);
    const vp = page.getViewport({ scale: 1.5 });
    const cv = document.createElement('canvas');
    cv.width = vp.width; cv.height = vp.height; document.body.appendChild(cv);
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    document.body.style.margin = '0';
  }, { data, pageNo: pageNo || 1 });
  await p.locator('canvas').screenshot({ path: out });
  await b.close();
  console.log('ok', out);
})();
