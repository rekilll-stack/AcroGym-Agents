'use strict';

require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const logger = createLogger('sheets');

// Hard timeout on every Google Sheets API call. Without it a slow/erroring
// Google backend makes the request hang indefinitely — the poll never
// completes, the heartbeat freezes, and the watchdog reports the agent as
// "hung". With a timeout the call aborts, the cycle fails fast, and the next
// poll recovers automatically once Google is healthy again.
const SHEETS_TIMEOUT_MS = Number(process.env.SHEETS_TIMEOUT_MS) || 30000;

// Transient Google/network blips (a few-second timeout, a 429/5xx, a reset
// socket) are the common case and recover on their own. Without a retry a
// single blip fails the whole poll cycle → no heartbeat → the watchdog thinks
// the agent "hung" and restarts it, which does nothing to fix a Google-side
// stall. A short bounded retry absorbs blips so only a SUSTAINED outage ever
// reaches the watchdog. Safe on reads (idempotent) and on updateCell (writing
// the same cell the same value is idempotent too).
const SHEETS_RETRIES = Math.max(1, Number(process.env.SHEETS_RETRIES) || 3);

function isTransient(err) {
  const msg  = String((err && err.message) || '');
  const code = Number(err && (err.code || err.status || (err.response && err.response.status)));
  return /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|EPIPE/i.test(msg)
    || [408, 429, 500, 502, 503, 504].includes(code);
}

async function withRetry(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= SHEETS_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= SHEETS_RETRIES || !isTransient(err)) throw err;
      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 5000); // 1s, 2s, 4s (cap 5s)
      logger.warn({ err: err.message, attempt, retries: SHEETS_RETRIES, label },
        `Sheets ${label}: transient error, retry in ${backoffMs}ms`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

let _authClient = null;
let _sheetsClient = null;

/**
 * Возвращает авторизованный Sheets-клиент (кэшируется).
 */
async function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;

  const keyPath = path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_PATH || './config/google-service-account.json');

  if (!fs.existsSync(keyPath)) {
    throw new Error(`Service account JSON не найден по пути: ${keyPath}`);
  }

  const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));

  _authClient = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  _sheetsClient = google.sheets({ version: 'v4', auth: _authClient });
  return _sheetsClient;
}

/**
 * Читает ВСЕ строки из листа ответов.
 * Первая строка — заголовки.
 *
 * @returns {Promise<Array<{ rowNumber: number, headers: string[], values: string[] }>>}
 */
async function fetchAllResponses() {
  const sheets = await getSheetsClient();
  const sheetId  = process.env.GOOGLE_SHEET_ID;
  const tabName  = process.env.GOOGLE_SHEET_RESPONSES_TAB || 'Form Responses 1';

  const res = await withRetry('read', () => sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: tabName,
  }, { timeout: SHEETS_TIMEOUT_MS }));

  const rows = res.data.values || [];
  if (rows.length === 0) return [];

  const [headers, ...dataRows] = rows;

  // debug: дамп заголовков только при LOG_LEVEL=debug (не спамим в out.log)
  logger.debug({ headers }, 'Sheet headers read (set LOG_LEVEL=debug to inspect)');

  return dataRows.map((values, idx) => ({
    rowNumber: idx + 2, // +2: строка 1 — заголовки, данные с 2-й
    headers,
    values,
  }));
}

/**
 * Возвращает номер последней строки с данными.
 */
async function getLastRowNumber() {
  const rows = await fetchAllResponses();
  if (rows.length === 0) return 1;
  return rows[rows.length - 1].rowNumber;
}

/**
 * Обновляет одну ячейку в таблице.
 *
 * @param {number} row     - номер строки (1-based)
 * @param {string} column  - буква колонки (A, B, C, ...)
 * @param {string} value   - значение
 */
async function updateCell(row, column, value) {
  const sheets = await getSheetsClient();
  const sheetId  = process.env.GOOGLE_SHEET_ID;
  const tabName  = process.env.GOOGLE_SHEET_RESPONSES_TAB || 'Form Responses 1';
  const range    = `${tabName}!${column}${row}`;

  await withRetry('update', () => sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] },
  }, { timeout: SHEETS_TIMEOUT_MS }));

  logger.debug({ range, value }, 'Ячейка обновлена');
}

module.exports = { fetchAllResponses, getLastRowNumber, updateCell };
