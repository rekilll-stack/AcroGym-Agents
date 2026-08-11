'use strict';

// Проверка Answer Bot без Telegram: 8 каверзных вопросов → реальный LLM (подписка).
// Ассерты: верные цены, запрещённые слова, английский ответ, отсутствие выдумок.
// Запуск: node scripts/test-answer-bot.js  (медленно: ~15-30с на вопрос)

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { generateText } = require('../agents/content-bot/llm');
const { buildAnswerPrompt } = require('../agents/answer-bot/prompts');

const CASES = [
  {
    name: 'цена терма 2х + какие дни',
    q: 'If I choose Monday Wednesday for term 1 is it cheaper than Tuesday Thursday? How much?',
    mustHave: ['3,300'],
    mustNot: ['trial', 'free'],
  },
  {
    name: 'болезнь и пропуски',
    q: 'What happens if my daughter gets sick and misses two weeks? Do we lose the money?',
    mustHave: ['freeze'],
    mustNot: ['deduct from the next payment', 'refund automatically'],
  },
  {
    name: 'просят скидку',
    q: 'Your prices are too expensive, can you give me a discount?',
    mustHave: [],
    mustNot: ['trial', 'free class', '20%', '10% off'],
  },
  {
    name: 'бесплатное пробное',
    q: 'Do you have a free trial class?',
    mustHave: ['100'],
    mustNot: ['free trial', 'yes, free'],
  },
  {
    name: 'вопрос не из базы (парковка)',
    q: 'Is there free parking at the mall and can I watch the class from inside the gym hall?',
    mustHave: [],
    mustNot: ['level 2 parking', 'VIP'],
  },
  {
    name: 'сколько занятий в месяце',
    q: 'September has more classes than October, why is the monthly price the same?',
    mustHave: ['average'],
    mustNot: [],
  },
  {
    name: 'вопрос Кристины по-русски',
    q: 'что ответить, если клиент говорит что в другом центре дешевле?',
    mustHave: [],
    mustNot: ['trial'],
  },
  {
    name: 'взрослые',
    q: 'I am 35 years old, can I train too or is it only for kids?',
    mustHave: ['18'],
    mustNot: [],
  },
];

(async () => {
  let pass = 0, fail = 0;
  for (const c of CASES) {
    let out = '';
    try { out = (await generateText(buildAnswerPrompt(c.q)) || '').trim(); }
    catch (e) { console.log(`\n=== ${c.name}: ❌ ОШИБКА LLM: ${e.message}`); fail++; continue; }
    const low = out.toLowerCase();
    const missing = c.mustHave.filter(s => !low.includes(s.toLowerCase()));
    const banned  = c.mustNot.filter(s => low.includes(s.toLowerCase()));
    const emptyish = out.length < 40;
    const ok = !missing.length && !banned.length && !emptyish;
    ok ? pass++ : fail++;
    console.log(`\n=== ${c.name}: ${ok ? '✅' : '❌'}${missing.length ? ' нет: ' + missing.join(',') : ''}${banned.length ? ' запрещённое: ' + banned.join(',') : ''}${emptyish ? ' слишком коротко' : ''}`);
    console.log(out);
  }
  console.log(`\n\nИТОГО: ${pass} ✅ / ${fail} ❌`);
  process.exit(fail ? 1 : 0);
})();
