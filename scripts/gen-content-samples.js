'use strict';

// One-off: generate live samples of each content format for tone review.
// Writes agents/content-bot/SAMPLES.md. Uses the real Claude path.
//   node scripts/gen-content-samples.js

const fs = require('fs');
const path = require('path');
const { generateContent } = require('../agents/content-bot/generate');
const { formatLabel } = require('../agents/content-bot/prompts');

const JOBS = [
  ['post',  'a child\'s first gymnastics class'],
  ['post',  'benefits of gymnastics for kids'],
  ['post',  'meet our coach Kristina'],
  ['ideas', 'benefits of gymnastics for young children'],
  ['ideas', 'pre-launch anticipation before our September opening'],
  ['plan',  'the month before AcroGym opens in September'],
  ['plan',  'first weeks of classes — building confidence'],
  ['post',  'пост про первое занятие ребёнка (RU input → EN output)'],
  ['ideas', 'идеи про пользу гимнастики для детей (RU input → EN output)'],
];

(async () => {
  const out = [
    '# Content-bot — sample output (C.2, tone review)',
    '',
    '_Generated drafts for Kirill to judge the WARM × PREMIUM voice. These are drafts only — nothing was published._',
    '',
  ];
  for (const [format, topic] of JOBS) {
    process.stderr.write(`generating ${format} :: ${topic}\n`);
    const text = await generateContent(format, topic);
    out.push(`## ${formatLabel(format)} — "${topic}"`, '', text, '', '---', '');
  }
  const dest = path.join(__dirname, '../agents/content-bot/SAMPLES.md');
  fs.writeFileSync(dest, out.join('\n'), 'utf8');
  process.stderr.write(`\n✅ wrote ${dest}\n`);
})().catch(e => { console.error('ERROR:', e.stack); process.exit(1); });
