'use strict';

// Регрессия Answer Bot v3: 13 кейсов через ПОЛНЫЙ прод-движок (черновик →
// редактор → страж) + вижн-кейс по синтетическому скриншоту.
// Запуск: node scripts/test-answer-bot.js  (долго: ~1 мин на кейс, 2 LLM-вызова)
// Быстрый прогон половины: node scripts/test-answer-bot.js --quick

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const { answer } = require('../agents/answer-bot/engine');

const AR = /[؀-ۿ]/; // арабские символы

const CASES = [
  { name: 'цена терма 2х + какие дни',
    q: 'If I choose Monday Wednesday for term 1 is it cheaper than Tuesday Thursday? How much?',
    check: (a) => a.includes('3,300') && !/\b(trial|free)\b/i.test(a) },
  { name: 'болезнь и пропуски',
    q: 'What happens if my daughter gets sick and misses two weeks? Do we lose the money?',
    check: (a) => /freeze/i.test(a) && /24/.test(a) },
  { name: 'просят скидку',
    q: 'Your prices are too expensive, can you give me a discount?',
    check: (a) => !/\b(20|25|30)% off/i.test(a) && !/\b(trial|free)\b/i.test(a) },
  { name: 'бесплатное пробное',
    q: 'Do you have a free trial class?',
    check: (a) => /100/.test(a) && !/\b(trial|free)\b/i.test(a.split('———')[0]) },
  { name: 'вопрос не из базы (парковка/просмотр)',
    q: 'Is there free parking at the mall and can I watch the class from inside the gym hall?',
    // суть: не УТВЕРЖДАТЬ факт о парковке, а честно обещать уточнить
    check: (a) => { const c = a.split('———')[0]; return !/parking (at the mall )?is free/i.test(c) && /(check|confirm|get back)/i.test(c); } },
  { name: 'сколько занятий в месяце',
    q: 'September has more classes than October, why is the monthly price the same?',
    check: (a) => /average/i.test(a) },
  { name: 'вопрос Кристины по-русски',
    q: 'что ответить, если клиент говорит что в другом центре дешевле?',
    check: (a) => !/\btrial\b/i.test(a) && a.length > 100 },
  { name: 'взрослые',
    q: 'I am 35 years old, can I train too or is it only for kids?',
    check: (a) => /18/.test(a) },
  { name: 'арабский вопрос → арабский ответ',
    q: 'هل عندكم حصص للأطفال عمر ٤ سنوات؟ وكم السعر؟',
    check: (a) => AR.test(a.split('———')[0]) },
  { name: 'многочастный (3 вопроса разом)',
    q: 'Three questions: what age groups do you have, how much is the first class, and when do you open?',
    check: (a) => /100/.test(a) && /september|1st/i.test(a) && /(2|age)/i.test(a) },
  { name: 'агрессивный клиент',
    q: 'This is a scam! You charge 100 riyals just to TRY a class?! Nobody does that!',
    check: (a) => !/scam/i.test(a.split('———')[0]) && /100/.test(a) && !/\b(trial|free)\b/i.test(a.split('———')[0]) },
  { name: 'возврат денег (нет в базе)',
    q: 'If we stop coming after one month of the term, will you refund the rest?',
    check: (a) => !/yes, we will refund|full refund/i.test(a) },
  { name: 'математика: 4 ребёнка 1х/нед месяц',
    q: 'We have 4 children, all once a week. How much per month for all of them?',
    // 550×2 + 467.5(15% на 3-го) + 4-й: политика в базе только про 3-го — не должен выдумать скидку больше
    check: (a) => /550/.test(a) && !/40%|50% off/i.test(a) },
];

(async () => {
  const quick = process.argv.includes('--quick');
  const cases = quick ? CASES.filter((_, i) => i % 2 === 0) : CASES;
  let pass = 0, fail = 0;
  for (const c of cases) {
    let out = '';
    try { out = await answer(c.q); }
    catch (e) { console.log(`\n=== ${c.name}: ❌ ОШИБКА: ${e.message}`); fail++; continue; }
    const ok = (() => { try { return c.check(out) && out.length > 40; } catch { return false; } })();
    ok ? pass++ : fail++;
    console.log(`\n=== ${c.name}: ${ok ? '✅' : '❌'}`);
    if (!ok) console.log(out);
    else console.log(out.slice(0, 160) + '…');
  }

  // Вижн-кейс (если есть синтетический скриншот)
  const shot = '/tmp/claude-1000/-home-admin/d8fd957c-b702-4f04-aa01-bc112a2d7a0a/scratchpad/wa-shot.jpg';
  if (!quick && fs.existsSync(shot)) {
    try {
      const data = fs.readFileSync(shot).toString('base64');
      const out = await answer(
        'Attached is a SCREENSHOT of a WhatsApp conversation with a client. Read it and reply to the latest unanswered question(s).',
        [], [{ media_type: 'image/jpeg', data }]);
      const ok = /550/.test(out) && /(3.?[-–—].?4|3 to 4|age of 3|for her age)/i.test(out);
      ok ? pass++ : fail++;
      console.log(`\n=== вижн-скриншот: ${ok ? '✅' : '❌'}`);
      if (!ok) console.log(out);
    } catch (e) { console.log('\n=== вижн-скриншот: ❌', e.message); fail++; }
  }

  console.log(`\n\nИТОГО: ${pass} ✅ / ${fail} ❌`);
  process.exit(fail ? 1 : 0);
})();
