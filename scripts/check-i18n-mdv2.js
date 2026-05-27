#!/usr/bin/env node
'use strict';

/**
 * scripts/check-i18n-mdv2.js
 *
 * Audits shared/i18n/en.json and ru.json for bare (unescaped) Telegram
 * MarkdownV2 reserved characters in static string values.
 *
 * MDv2 reserved chars: _ * [ ] ( ) ~ ` > # + - = | { } . !
 *
 * What is ignored (intentional):
 *   - *text*         bold
 *   - _text_         italic
 *   - `text`         inline code
 *   - ```text```     code block
 *   - [text](url)    link
 *   - {{var}}        Handlebars template vars
 *   - \\<char>       already-escaped sequences (JSON: "\\\\!" → JS string "\\!")
 *
 * Usage:
 *   node scripts/check-i18n-mdv2.js
 *   node scripts/check-i18n-mdv2.js --strict   # also flag . (period) and - (hyphen)
 */

const path  = require('path');
const files = {
  en: require(path.join(__dirname, '../shared/i18n/en.json')),
  ru: require(path.join(__dirname, '../shared/i18n/ru.json')),
};

// Characters that MUST be escaped in MDv2 literal text
// We split into two groups:
//   CRITICAL  — almost always literal, almost never markdown syntax
//   REVIEW    — context-dependent (. and - are very common in natural text;
//               only flag if you pass --strict)
const CRITICAL  = ['|', '!', '#', '+', '=', '~', '`', '>', '{', '}'];
const REVIEW    = ['.', '-'];

const STRICT = process.argv.includes('--strict');
const CHECK  = STRICT ? [...CRITICAL, ...REVIEW] : CRITICAL;

// ─────────────────────────────────────────────────────────────
// Strip patterns that are intentional MDv2 / Handlebars
// ─────────────────────────────────────────────────────────────
function stripSafe(s) {
  return s
    // Already-escaped sequences  \\X  (JSON "\\\\X" → JS "\\X")
    .replace(/\\./g, '  ')
    // Handlebars template vars  {{foo}}
    .replace(/\{\{[^}]+\}\}/g, '  ')
    // Inline code  `...`
    .replace(/`[^`]*`/g, '  ')
    // Bold  *text*  (simple heuristic — not nested)
    .replace(/\*[^*]+\*/g, '  ')
    // Italic  _text_
    .replace(/_[^_]+_/g, '  ')
    // Markdown link  [text](url)
    .replace(/\[[^\]]*\]\([^)]*\)/g, '  ');
}

// Sections that are used for PDF/PPTX canvas rendering (not Telegram MDv2)
// — skipped because escaping there would put literal backslashes in documents.
const SKIP_SECTIONS = new Set(['pdf', 'pptx']);

// ─────────────────────────────────────────────────────────────
// Walk a nested object, collect all leaf string values
// ─────────────────────────────────────────────────────────────
function* walkStrings(obj, prefix = '') {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    const topSection = key.split('.')[0];
    if (SKIP_SECTIONS.has(topSection)) continue;   // PDF/PPTX — not Telegram
    if (typeof v === 'string') {
      yield [key, v];
    } else if (v && typeof v === 'object') {
      yield* walkStrings(v, key);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Run audit
// ─────────────────────────────────────────────────────────────
let warnings = 0;

for (const [lang, data] of Object.entries(files)) {
  const issues = [];

  for (const [key, raw] of walkStrings(data)) {
    const stripped = stripSafe(raw);
    const found = [];

    for (const ch of CHECK) {
      if (stripped.includes(ch)) {
        found.push(ch);
      }
    }

    if (found.length > 0) {
      issues.push({ key, raw, found });
    }
  }

  if (issues.length === 0) {
    console.log(`✅  ${lang}.json — no bare MDv2 special chars found`);
  } else {
    console.log(`\n⚠️  ${lang}.json — ${issues.length} issue(s):\n`);
    for (const { key, raw, found } of issues) {
      const preview = raw.length > 80 ? raw.slice(0, 77) + '...' : raw;
      console.log(`  [${found.map(c => `'${c}'`).join(', ')}]  ${key}`);
      console.log(`     ${preview}`);
    }
    warnings += issues.length;
  }
}

console.log('');
if (warnings === 0) {
  console.log('✅  All clean.');
} else {
  console.log(`⚠️  Total issues: ${warnings}`);
  if (!STRICT) console.log('    (run with --strict to also flag bare . and -)');
  process.exit(1);
}
