'use strict';

// Диапазоны Unicode для кириллицы и арабского письма
const CYRILLIC_RE = /[Ѐ-ӿ]/;
const ARABIC_RE   = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

/**
 * Определяет язык по имени родителя.
 *
 * @param {string} name
 * @returns {'RU'|'EN'|'AR'}
 */
function detectLanguage(name) {
  if (!name || typeof name !== 'string' || name.trim() === '') return 'EN';

  if (CYRILLIC_RE.test(name)) return 'RU';
  if (ARABIC_RE.test(name))   return 'AR';

  return 'EN';
}

module.exports = { detectLanguage };
