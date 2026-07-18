'use strict';
// Демо контент-студии (dry-run в консоль, без Telegram). Прогоняет всю команду
// на Sonnet 5 по заданной теме. Тему можно передать аргументом.
require('dotenv').config();
const { runSession } = require('../agents/content-studio/studio');

(async () => {
  const topic = process.argv.slice(2).join(' ') || 'Летний интенсив в августе — набор открыт';
  console.log(`\n🎬 КОНТЕНТ-СТУДИЯ AcroGym — тема: «${topic}»\n${'='.repeat(64)}\n`);
  const { transcript } = await runSession({ topic });
  for (const t of transcript) {
    console.log(`${t.emoji} ${t.name}:\n${t.text}\n${'-'.repeat(40)}`);
  }
  console.log('='.repeat(64), '\n');
})().catch((e) => { console.error('studio demo failed:', e.message); process.exit(1); });
