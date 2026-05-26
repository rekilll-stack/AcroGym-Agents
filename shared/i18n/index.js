'use strict';

const en = require('./en.json');
const ru = require('./ru.json');

const CATALOGS  = { en, ru };
const SUPPORTED = new Set(['en', 'ru']);

// ─────────────────────────────────────────────────────────────
// Internal: resolve a dot-path like 'daily.title' in a catalog
// ─────────────────────────────────────────────────────────────
function _resolve(obj, key) {
  const parts = key.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur !== null && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, part)) {
      cur = cur[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Translate a key to the given language with optional {{var}} interpolation.
 *
 * @param {string}  key        - Dot-path key, e.g. 'daily.title' or 'common.uptime.hours_short'
 * @param {string}  [lang='en']- Language code: 'en' | 'ru'
 * @param {object}  [vars={}]  - Interpolation variables: { name: 'Kirill', count: 5 }
 * @returns {string}
 */
function t(key, lang = 'en', vars = {}) {
  const catalog = CATALOGS[SUPPORTED.has(lang) ? lang : 'en'];

  // Try requested language, fallback to EN, fallback to raw key
  let str = _resolve(catalog, key);
  if (str === undefined) str = _resolve(en, key);
  if (str === undefined) return key;  // return raw key as last resort

  if (typeof str !== 'string') return String(str ?? key);

  // {{var}} interpolation (Handlebars-style)
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v ?? ''));
  }
  return str;
}

/**
 * Get a raw translated value (object, array, or string) by dot-path key.
 * Useful for month_names / day_names objects.
 *
 * @param {string} key
 * @param {string} [lang='en']
 * @returns {*}
 */
function tObj(key, lang = 'en') {
  const catalog = CATALOGS[SUPPORTED.has(lang) ? lang : 'en'];
  let val = _resolve(catalog, key);
  if (val === undefined) val = _resolve(en, key);
  return val;
}

/**
 * Get a translated array by dot-path key.
 * @param {string} key
 * @param {string} [lang='en']
 * @returns {Array}
 */
function tArr(key, lang = 'en') {
  const val = tObj(key, lang);
  return Array.isArray(val) ? val : [];
}

/**
 * Create a translator bound to a specific language.
 * Useful in builder functions where lang is fixed.
 *
 * @param {string} lang
 * @returns {{ t: Function, tArr: Function, tObj: Function }}
 */
function createTranslator(lang = 'en') {
  return {
    t:    (key, vars = {}) => t(key, lang, vars),
    tArr: (key)            => tArr(key, lang),
    tObj: (key)            => tObj(key, lang),
  };
}

module.exports = { t, tArr, tObj, createTranslator, SUPPORTED };
