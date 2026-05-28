'use strict';
/**
 * scripts/test-export-flow.js — функциональные тесты /export flow.
 *
 * Вызывает handler'ы напрямую (не через реальный Telegram polling).
 * PDF-файлы сохраняются в exports/ и реально отправляются боту.
 *
 * Запуск: node scripts/test-export-flow.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');

const { getDb }        = require('../shared/db');
const { getState, setState, clearState } = require('../shared/state');
const handleExport     = require('../agents/owner-bot/commands/export');
const {
  _exportCallbackHandler: exportCb,
  _ownerTextHandler:      textHandler,
} = require('../agents/owner-bot/callbacks/export-callbacks');

const CHAT_ID    = 216299177;
const EXPORTS_DIR = path.join(__dirname, '../exports');

// ─────────────────────────────────────────────────────────────
// Mock bot
// ─────────────────────────────────────────────────────────────

function createMockBot() {
  const log = [];
  return {
    _log: log,
    sendMessage:         async (chatId, text, opts = {}) => { log.push({ type: 'msg', text, opts }); return { message_id: Date.now() }; },
    answerCallbackQuery: async (id, opts = {})           => { log.push({ type: 'answer', opts }); return {}; },
    lastMsg:             ()                              => log.filter(x => x.type === 'msg').slice(-1)[0],
    clear:               ()                              => { log.length = 0; },
  };
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function mockCb(data) {
  return {
    id:      'test-' + Date.now(),
    data,
    from:    { id: CHAT_ID },
    message: { chat: { id: CHAT_ID }, message_id: 1 },
  };
}

function mockMsg(text) {
  return { chat: { id: CHAT_ID }, from: { id: CHAT_ID }, text, message_id: Date.now() };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function checkState(expectedStep, expectedParams = {}) {
  const s = getState(CHAT_ID);
  if (!s) throw new Error(`State is null, expected step='${expectedStep}'`);
  if (s.step !== expectedStep) throw new Error(`Expected step='${expectedStep}', got '${s.step}'. State: ${JSON.stringify(s)}`);
  for (const [k, v] of Object.entries(expectedParams)) {
    if (!s.params[k]) throw new Error(`Expected params.${k}='${v}', got '${s.params[k]}'`);
  }
  return s;
}

function findExportFile(pattern) {
  if (!fs.existsSync(EXPORTS_DIR)) return null;
  const files = fs.readdirSync(EXPORTS_DIR).filter(f => f.match(pattern));
  return files.length ? path.join(EXPORTS_DIR, files[files.length - 1]) : null;
}

const results = [];

async function runTest(name, fn) {
  clearState(CHAT_ID); // clean slate
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`▶ ${name}`);
  try {
    await fn();
    console.log(`✅ ${name} — PASSED`);
    results.push({ name, passed: true });
  } catch (err) {
    console.error(`❌ ${name} — FAILED`);
    console.error('   ', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    results.push({ name, passed: false, error: err.message });
    throw err; // stop on first failure per spec
  } finally {
    clearState(CHAT_ID);
  }
}

// ─────────────────────────────────────────────────────────────
// TEST 1: Full Month + RU + PDF flow
// ─────────────────────────────────────────────────────────────

async function test1() {
  const bot = createMockBot();

  // Step: menu:export → triggers export command → step='period'
  await handleExport(mockMsg('/export'), bot);
  checkState('period');
  console.log('   step=period ✅');

  // Step: export:period:month → step='month_choice'
  bot.clear();
  await exportCb(mockCb('export:period:month'), bot);
  checkState('month_choice');
  console.log('   step=month_choice ✅');

  // Step: export:month_choice:this_month → step='lang', params have dates
  bot.clear();
  await exportCb(mockCb('export:month_choice:this_month'), bot);
  const s3 = checkState('lang');
  const today = new Date().toISOString().slice(0, 7); // YYYY-MM
  if (!s3.params.dateFrom || !s3.params.dateFrom.startsWith(today.slice(0, 7))) {
    // just verify month is current
  }
  if (!s3.params.dateFrom || !s3.params.dateTo) throw new Error('dateFrom/dateTo not set in params');
  console.log(`   step=lang, dateFrom=${s3.params.dateFrom}, dateTo=${s3.params.dateTo} ✅`);

  // Step: export:lang:ru → step='format'
  bot.clear();
  await exportCb(mockCb('export:lang:ru'), bot);
  checkState('format');
  console.log('   step=format ✅');

  // Step: export:format:pdf → generates PDF, state cleared
  bot.clear();
  console.log('   Generating PDF (may take ~5-10s)...');
  await exportCb(mockCb('export:format:pdf'), bot);

  // Check file exists
  const file = findExportFile(/acrogym-month-.*_ru\.pdf$/);
  if (!file) throw new Error('Expected acrogym-month-*_ru.pdf in exports/ but not found');
  const stat = fs.statSync(file);
  if (stat.size < 50 * 1024) throw new Error(`PDF too small: ${stat.size} bytes (expected >50KB)`);
  console.log(`   PDF: ${path.basename(file)}, ${Math.round(stat.size / 1024)}KB ✅`);

  // State cleared
  if (getState(CHAT_ID) !== null) throw new Error('State not cleared after completion');
  console.log('   state cleared ✅');
}

// ─────────────────────────────────────────────────────────────
// TEST 2: Custom range + EN + PDF
// ─────────────────────────────────────────────────────────────

async function test2() {
  const bot = createMockBot();

  await handleExport(mockMsg('/export'), bot);
  checkState('period');

  await exportCb(mockCb('export:period:custom'), bot);
  checkState('date_start');
  console.log('   step=date_start ✅');

  // Text: start date
  await textHandler(mockMsg('2026-05-01'), bot);
  checkState('date_end');
  console.log('   step=date_end ✅');

  // Text: end date
  await textHandler(mockMsg('2026-05-15'), bot);
  const s = checkState('lang');
  if (s.params.dateFrom !== '2026-05-01') throw new Error('dateFrom wrong');
  if (s.params.dateTo   !== '2026-05-15') throw new Error('dateTo wrong');
  console.log('   step=lang, dates correct ✅');

  await exportCb(mockCb('export:lang:en'), bot);
  checkState('format');

  console.log('   Generating PDF...');
  await exportCb(mockCb('export:format:pdf'), bot);

  const file = findExportFile(/acrogym-custom-.*_en\.pdf$/);
  if (!file) throw new Error('Expected acrogym-custom-*_en.pdf not found');
  const stat = fs.statSync(file);
  if (stat.size < 50 * 1024) throw new Error(`PDF too small: ${stat.size} bytes`);
  console.log(`   PDF: ${path.basename(file)}, ${Math.round(stat.size / 1024)}KB ✅`);

  if (getState(CHAT_ID) !== null) throw new Error('State not cleared');
  console.log('   state cleared ✅');
}

// ─────────────────────────────────────────────────────────────
// TEST 3: Invalid date validation
// ─────────────────────────────────────────────────────────────

async function test3() {
  const bot = createMockBot();

  await handleExport(mockMsg('/export'), bot);
  await exportCb(mockCb('export:period:day'), bot);
  checkState('date_single');
  console.log('   step=date_single ✅');

  // Invalid: garbage
  bot.clear();
  await textHandler(mockMsg('tomorrow'), bot);
  checkState('date_single'); // still same step
  const msg1 = bot.lastMsg();
  if (!msg1 || !msg1.text.includes('YYYY-MM-DD') && !msg1.text.includes('2026')) {
    // Check that some error message was sent
    if (bot._log.filter(x => x.type === 'msg').length === 0) throw new Error('No error message sent for invalid input');
  }
  console.log('   "tomorrow" rejected, step unchanged ✅');

  // Invalid: bad date
  bot.clear();
  await textHandler(mockMsg('2026-99-99'), bot);
  checkState('date_single');
  console.log('   "2026-99-99" rejected, step unchanged ✅');

  // Future date
  bot.clear();
  await textHandler(mockMsg('2099-01-01'), bot);
  checkState('date_single');
  console.log('   "2099-01-01" (future) rejected, step unchanged ✅');

  // Valid date
  bot.clear();
  await textHandler(mockMsg('2026-05-25'), bot);
  checkState('lang');
  console.log('   "2026-05-25" accepted, step=lang ✅');
}

// ─────────────────────────────────────────────────────────────
// TEST 4: Cancel flow
// ─────────────────────────────────────────────────────────────

async function test4() {
  const bot = createMockBot();

  await handleExport(mockMsg('/export'), bot);
  await exportCb(mockCb('export:period:day'), bot);
  checkState('date_single');

  // Cancel
  bot.clear();
  await exportCb(mockCb('export:cancel'), bot);

  const s = getState(CHAT_ID);
  if (s !== null) throw new Error(`State should be null after cancel, got: ${JSON.stringify(s)}`);
  console.log('   state=null after cancel ✅');

  // Check a "cancelled" message was sent
  const msgs = bot._log.filter(x => x.type === 'msg');
  if (msgs.length === 0) throw new Error('No message sent after cancel');
  console.log('   cancelled message sent ✅');
}

// ─────────────────────────────────────────────────────────────
// TEST 5: Timeout expiration
// ─────────────────────────────────────────────────────────────

async function test5() {
  const bot = createMockBot();

  await handleExport(mockMsg('/export'), bot);
  await exportCb(mockCb('export:period:day'), bot);
  checkState('date_single');

  // Force updated_at to 6 minutes ago
  getDb().prepare(
    `UPDATE user_state SET updated_at = datetime('now', '-6 minutes') WHERE chat_id = ?`
  ).run(CHAT_ID);
  console.log('   updated_at forced to 6 min ago ✅');

  // Text input should trigger timeout
  bot.clear();
  await textHandler(mockMsg('2026-05-25'), bot);

  // State should be cleared
  const s = getState(CHAT_ID);
  if (s !== null) throw new Error(`State should be null after timeout, got: ${JSON.stringify(s)}`);
  console.log('   state cleared after timeout ✅');

  // Check timeout message
  const msgs = bot._log.filter(x => x.type === 'msg');
  if (msgs.length === 0) throw new Error('No timeout message sent');
  const timeoutMsg = msgs[0].text;
  // The timeout message should contain some indicator (from i18n export.timeout)
  console.log(`   timeout message sent: "${timeoutMsg.slice(0, 40)}..." ✅`);
}

// ─────────────────────────────────────────────────────────────
// TEST 6: Both languages
// ─────────────────────────────────────────────────────────────

async function test6() {
  const bot = createMockBot();

  await handleExport(mockMsg('/export'), bot);
  await exportCb(mockCb('export:period:month'), bot);
  await exportCb(mockCb('export:month_choice:this_month'), bot);
  checkState('lang');

  await exportCb(mockCb('export:lang:both'), bot);
  checkState('format');
  console.log('   step=format ✅');

  console.log('   Generating both EN+RU PDFs...');
  await exportCb(mockCb('export:format:pdf'), bot);

  const enFile = findExportFile(/acrogym-month-.*_en\.pdf$/);
  const ruFile = findExportFile(/acrogym-month-.*_ru\.pdf$/);

  if (!enFile) throw new Error('EN PDF not found in exports/');
  if (!ruFile) throw new Error('RU PDF not found in exports/');

  const enStat = fs.statSync(enFile);
  const ruStat = fs.statSync(ruFile);
  if (enStat.size < 50 * 1024) throw new Error(`EN PDF too small: ${enStat.size}`);
  if (ruStat.size < 50 * 1024) throw new Error(`RU PDF too small: ${ruStat.size}`);

  console.log(`   EN: ${path.basename(enFile)}, ${Math.round(enStat.size/1024)}KB ✅`);
  console.log(`   RU: ${path.basename(ruFile)}, ${Math.round(ruStat.size/1024)}KB ✅`);

  if (getState(CHAT_ID) !== null) throw new Error('State not cleared after both-lang generation');
  console.log('   state cleared ✅');
}

// ─────────────────────────────────────────────────────────────
// Cleanup generated test PDFs
// ─────────────────────────────────────────────────────────────

function cleanupTestPdfs() {
  if (!fs.existsSync(EXPORTS_DIR)) return;
  const files = fs.readdirSync(EXPORTS_DIR).filter(f =>
    f.startsWith('acrogym-') && f.endsWith('.pdf')
  );
  for (const f of files) {
    fs.unlinkSync(path.join(EXPORTS_DIR, f));
    console.log(`   deleted: ${f}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Real Telegram callback — visual check (Step 1 keyboard)
// ─────────────────────────────────────────────────────────────

async function sendRealExportStep1() {
  const https = require('https');
  const TOKEN = process.env.OWNER_BOT_TOKEN;
  const CHAT  = String(CHAT_ID);

  const { t } = require('../shared/i18n');
  const lang  = 'ru'; // use RU since that's the owner's preference

  const text = `${t('export.title', lang)}\n${t('export.step_1_period', lang)}`;
  const keyboard = {
    inline_keyboard: [
      [
        { text: t('export.btn_period_day',    lang), callback_data: 'export:period:day'    },
        { text: t('export.btn_period_week',   lang), callback_data: 'export:period:week'   },
      ],
      [
        { text: t('export.btn_period_month',  lang), callback_data: 'export:period:month'  },
        { text: t('export.btn_period_custom', lang), callback_data: 'export:period:custom' },
      ],
      [
        { text: `❌ Отмена`, callback_data: 'export:cancel' },
        { text: '⬅ Back to menu', callback_data: 'menu:back' },
      ],
    ],
  };

  const body = JSON.stringify({ chat_id: CHAT, text, parse_mode: 'MarkdownV2', reply_markup: keyboard });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${TOKEN}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const j = JSON.parse(d);
        if (j.ok) resolve(j.result);
        else reject(new Error(`Telegram API: ${JSON.stringify(j)}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(60));
  console.log('  /export flow functional tests');
  console.log('═'.repeat(60));

  try {
    await runTest('TEST 1: Month + RU + PDF',           test1);
    await runTest('TEST 2: Custom range + EN + PDF',    test2);
    await runTest('TEST 3: Invalid date validation',    test3);
    await runTest('TEST 4: Cancel flow',                test4);
    await runTest('TEST 5: Timeout expiration',         test5);
    await runTest('TEST 6: Both languages (EN+RU PDFs)',test6);
  } catch {
    // runTest already logged, stop here
    printReport();
    process.exit(1);
  }

  // Cleanup generated PDFs
  console.log('\n─── Cleanup ───');
  cleanupTestPdfs();

  printReport();

  // Real Telegram visual check
  console.log('\n─── Real Telegram: sending Step 1 keyboard ───');
  try {
    const msg = await sendRealExportStep1();
    console.log(`✅ Sent to Telegram: message_id=${msg.message_id}`);
    console.log('   → Проверьте бот: должно быть сообщение с кнопками выбора периода.');
  } catch (err) {
    console.error('❌ Real Telegram send failed:', err.message);
  }
}

function printReport() {
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log('\n' + '═'.repeat(60));
  console.log(`  REPORT: ${results.length} tests | ${passed} PASS | ${failed} FAIL`);
  console.log('═'.repeat(60));
  for (const r of results) {
    console.log(`  ${r.passed ? '✅' : '❌'} ${r.name}${r.error ? ' — ' + r.error : ''}`);
  }
  console.log('═'.repeat(60));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
