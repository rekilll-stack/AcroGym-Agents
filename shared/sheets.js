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

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: tabName,
  }, { timeout: SHEETS_TIMEOUT_MS });

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

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] },
  }, { timeout: SHEETS_TIMEOUT_MS });

  logger.debug({ range, value }, 'Ячейка обновлена');
}

module.exports = { fetchAllResponses, getLastRowNumber, updateCell };
