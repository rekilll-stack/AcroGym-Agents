'use strict';

// Регрессия Answer Bot v3: 35 кейсов через ПОЛНЫЙ прод-движок (черновик →
// редактор → страж) + вижн-кейс по синтетическому скриншоту.
// Запуск: node scripts/test-answer-bot.js  (долго: ~1 мин на кейс, 2 LLM-вызова)
// Быстрый прогон половины (чётные): --quick; вторая половина (нечётные): --rest; только FAQ прохода 2: --new; --full печатает ответы целиком

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const { answer, deepAnswer } = require('../agents/answer-bot/engine');

const AR = /[؀-ۿ]/; // арабские символы

const CASES = [
  { name: 'дни не влияют на цену, терм-цен не называть',
    q: 'If I choose Monday Wednesday for term 1 is it cheaper than Tuesday Thursday? How much?',
    // с 26.09 в прайсе только месячные: 1,100 за 2×/нед, старые терм-цены звучать не должны
    check: (a) => a.includes('1,100') && !/3,?300/.test(a) && !/\b(trial|free)\b/i.test(a) },
  { name: 'болезнь и пропуски',
    q: 'What happens if my daughter gets sick and misses two weeks? Do we lose the money?',
    // T&C называет механизм extension weeks — ответ может сказать «extend» вместо «freeze»
    check: (a) => /(freeze|extend)/i.test(a) && /24/.test(a) },
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
    check: (a) => /30.?days?/i.test(a.split('———')[0]) },
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
    check: (a) => /100/.test(a) && /september|1st/i.test(a) && /(2|age)/i.test(a) && !/boys and girls/i.test(a) },
  { name: 'агрессивный клиент',
    q: 'This is a scam! You charge 100 riyals just to TRY a class?! Nobody does that!',
    check: (a) => !/scam/i.test(a.split('———')[0]) && /100/.test(a) && !/\b(trial|free)\b/i.test(a.split('———')[0]) },
  { name: 'возврат денег (нет в базе)',
    q: 'If we stop coming after one month of the term, will you refund the rest?',
    check: (a) => !/yes, we will refund|full refund/i.test(a) },
  { name: 'русскоязычный клиент → ответ по-русски',
    q: 'Здравствуйте! Дочке 6 лет, хотим 2 раза в неделю. Сколько стоит месяц и как записаться?',
    check: (a) => { const c = a.split('———')[0]; return /[а-яё]/i.test(c) && /1[ ,]?100/.test(c); } },
  { name: 'математика: 4 ребёнка 1х/нед месяц',
    q: 'We have 4 children, all once a week. How much per month for all of them?',
    // 550×2 + 467.5(15% на 3-го) + 4-й: политика в базе только про 3-го — не должен выдумать скидку больше
    check: (a) => /550/.test(a) && !/40%|50% off/i.test(a) },

  // ── Новые знания (переобучение 04.10) ──
  { name: 'скидка −5% за продление',
    q: "My son's monthly plan (twice a week) ends tomorrow. Do we get anything if we renew?",
    check: (a) => { const c = a.split('———')[0]; return /5\s?%/.test(c) && !/10\s?%/.test(c); } },
  { name: 'персоналки + пакет 10',
    q: 'Do you have private lessons? What is the price for a pack of 10?',
    check: (a) => { const c = a.split('———')[0]; return /300/.test(c) && /2,?700/.test(c); } },
  { name: 'зимние каникулы',
    q: 'Are you open during the winter holidays in December? When do classes start again?',
    check: (a) => { const c = a.split('———')[0]; return /18/.test(c) && /(4 jan|january 4|4th (of )?jan|jan(uary)? 4)/i.test(c); } },
  { name: 'отмена за 3 часа',
    q: 'If I cancel the class 3 hours before it starts, will it still count?',
    check: (a) => { const c = a.split('———')[0]; return /24/.test(c) && /(used|count)/i.test(c); } },
  { name: 'расписание для 4 лет',
    q: 'What days and times do you have for my 4 year old son?',
    check: (a) => { const c = a.split('———')[0]; return /(3\s?[–-]\s?4|4\s?[–-]\s?6)/.test(c) && /(\d{1,2}:\d{2}|\d\s?(am|pm))/i.test(c); } },
  { name: 'арабский: месячный 2×',
    q: 'كم سعر الاشتراك الشهري مرتين في الأسبوع؟',
    check: (a) => { const c = a.split('———')[0]; return AR.test(c) && (/1[,.]?100/.test(c) || /١[٬,.]?١٠٠/.test(c)); } },
  { name: 'заморозка на месяц → уточнить у команды',
    q: 'We are travelling for the whole of November. Can we freeze our monthly plan for a month?',
    check: (a) => { const c = a.split('———')[0]; return /(check|confirm|get back)/i.test(c) && /week/i.test(c); } },
  { name: 'русский клиент: 9 лет, дни и цена',
    q: 'Здравствуйте! Сыну 9 лет. В какие дни у вас занятия и сколько стоит раз в неделю?',
    check: (a) => { const c = a.split('———')[0]; return /[а-яё]/i.test(c) && /550/.test(c) && /\d{1,2}:\d{2}/.test(c); } },
  { name: 'трое детей 2×/нед: 15% на третьего',
    q: 'I have 3 kids, all would come twice a week on the monthly plan. How much in total?',
    // 1,100 + 1,100 + 935 (−15%) = 3,135
    check: (a) => { const c = a.split('———')[0]; return /3,?135/.test(c) && /15\s?%/.test(c); } },
  { name: 'терм 2: цен не выдумывать',
    q: 'Can I buy a term plan for Term 2 in January? How much is it?',
    // владелец 05.10: терм больше не продаётся → предложить месячный, цен терма не называть
    check: (a) => { const c = a.split('———')[0]; return !/(1,?900|2,?900|4,?100|4,?500)/.test(c) && /monthly/i.test(c); } },
  { name: 'запись на первое занятие в субботу',
    q: "Hi, I'd like to book a first class for my 6 year old daughter this Saturday. What do I need to do?",
    check: (a) => { const c = a.split('———')[0]; return /acrogym\.org\/register/.test(c) && /100/.test(c) && !/\b(trial|free)\b/i.test(c); } },
  { name: 'что надеть',
    q: 'What should my daughter wear for her first class?',
    check: (a) => { const c = a.split('———')[0]; return /sock/i.test(c) && /hair/i.test(c); } },
  { name: 'рассрочка и мальчики/девочки: не выдумывать (фактчек 04.10)',
    q: 'Can I pay the monthly plan in two installments? And are boys and girls in the same group?',
    check: (a) => { const c = a.split('———')[0]; return /check|confirm|get back/i.test(c) && !/installments? (are|is) not|boys and girls (train|are) together/i.test(c); } },

  // ── FAQ из реальных вопросов клиентов (проход 2, 04.10; флаг --new гоняет только их) ──
  { name: 'реальный: «каждое занятие 100?»', isNew: true,
    q: 'Each class costs 100?',
    // владелец 05.10: разовое — 250; 100 — только первое занятие
    check: (a) => { const c = a.split('———')[0]; return /first class/i.test(c) && !/single class[^\n]{0,40}\b100\b/i.test(c) && /(137\.5|125|550|1,?100)/.test(c) && !/\b(trial|free)\b/i.test(c) && !/(yes|correct)\b[^\n]{0,30}each class[^\n]{0,20}100/i.test(c); } },
  { name: 'реальный: скидка на двойняшек', isNew: true,
    q: 'Good afternoon, I have twins, is it possible to have a discount for 2 children?',
    check: (a) => { const c = a.split('———')[0]; return /15\s?%/.test(c) && /(3rd|third)/i.test(c) && !/(10|15|20)\s?% (off )?(for|on) (the )?(twins|both|second|2nd)/i.test(c); } },
  { name: 'реальный: расписание для 3 и 9 лет', isNew: true,
    q: 'Hello! May I know timetable for 3 and 9 years old?',
    check: (a) => { const c = a.split('———')[0]; return /3\s?[–-]\s?4/.test(c) && /7\s?[–-]\s?10/.test(c) && (c.match(/\d{1,2}:\d{2}/g) || []).length >= 2; } },
  { name: 'реальный: цена, время, адрес (после формы)', isNew: true,
    q: "Hello! I filled out your form and would like to know more.\nChild's age: 7\nPrice timings and location",
    check: (a) => { const c = a.split('———')[0]; return /lagoona/i.test(c) && /\d{1,2}:\d{2}/.test(c) && /100/.test(c) && /(550|1,?100)/.test(c); } },
  { name: 'астма: письменно + врач, без мед.советов', isNew: true,
    q: 'My son has asthma. Is it safe for him to do gymnastics with you?',
    check: (a) => { const c = a.split('———')[0]; return /(whatsapp|info@acrogym\.org|in writing|let us know|tell us)/i.test(c) && /(doctor|physician|paediatrician|pediatrician)/i.test(c); } },
  { name: 'оставить ребёнка и уйти в молл: не выдумывать', isNew: true,
    q: 'Can I leave my daughter at the class and go shopping in the mall while she trains?',
    check: (a) => { const c = a.split('———')[0]; return /(pick|on time)/i.test(c) && /(check|confirm|get back)/i.test(c) && !/(feel free|you are welcome|you're welcome|of course you can) (to )?(go )?shop/i.test(c); } },
  // владелец 05.10: про паузу на каникулах не упоминать, ничего не обещать
  { name: 'вопросы владельца не отвечать фактом: пауза на каникулы + скидка за 3 мес', isNew: true,
    q: 'If we pay for 3 months at once, is there a discount? And will our monthly plan be paused during the winter break?',
    check: (a) => { const c = a.split('———')[0]; return /(check|confirm|get back)/i.test(c) && !/(10|20|25)\s?%/.test(c) && !/(plan|it) (will be|is) (paused|frozen|extended) (during|over|for) the (winter )?(break|holidays?)/i.test(c); } },
  { name: 'каникулы: про паузу абонемента сам не заговаривает (владелец 05.10)', isNew: true,
    q: 'When is your spring break and when do classes start again?',
    check: (a) => { const c = a.split('———')[0]; return /(8|21)/.test(c) && !/(paus|freez|extend|extension)/i.test(c); } },
  { name: 'скидки: 3-й ребёнок при продлении — и 15%, и 5% (владелец 05.10)', isNew: true,
    q: 'Our third child renews her monthly plan on the day it ends. Which discounts does she get?',
    check: (a) => { const c = a.split('———')[0]; return /15\s?%/.test(c) && /5\s?%/.test(c) && !/(only one|cannot be combined|can't be combined|not combined)/i.test(c); } },
  // глубокий режим (владелец 05.10): память+документы, источник в заметке, без выдумок и без старых цен
  { name: 'глубокий режим: парковка + смотреть из зала', isNew: true, deep: true,
    q: "Is there parking at the mall? And can I watch my daughter's class from inside the hall?",
    check: (a) => { const [c, n = ''] = a.split('———'); return /park/i.test(c) && /(check|confirm|get back)/i.test(c) && !/(1,?600|1,?700|1,?650|4,?100|4,?500)/.test(c) && /(памят|база|источник|memory|source)/i.test(n); } },
  { name: 'вопросы владельца: взрослые цена + родитель в 1.5–2', isNew: true,
    q: "I'm 30 — how much are your adult classes? And for my 20-month-old, does a parent stay in the class with her?",
    check: (a) => { const c = a.split('———')[0]; return /(check|confirm|get back)/i.test(c) && !/adult[^\n]{0,80}(550|1,?100|1,?500)/i.test(c) && !/(550|1,?100|1,?500)[^\n]{0,80}adult/i.test(c) && !/parents? (joins?|stays?|participates?) (in|with)/i.test(c); } },
];

// Статическая проверка: цифры в шаблонах существуют в базе знаний (защита от рассинхрона цен).
function templatesConsistent() {
  const kb = fs.readFileSync(require('path').join(__dirname, '../agents/answer-bot/knowledge.md'), 'utf8');
  const { TEMPLATES } = require('../agents/answer-bot/templates');
  const problems = [];
  for (const [k, t] of Object.entries(TEMPLATES)) {
    const nums = (t.text.match(/\d[\d,\.]{1,6}/g) || []).map(n => n.replace(/[,.]$/, ''));
    for (const n of nums) {
      if (['1', '2', '3'].includes(n)) continue; // счётные мелочи
      if (!kb.includes(n)) problems.push(`${k}: ${n}`);
    }
    if (/\b(trial|free)\b/i.test(t.text)) problems.push(`${k}: запрещённое слово`);
    if (!t.label || !t.label.ru || !t.label.en) problems.push(`${k}: подпись не на двух языках`);
  }
  // Старые терм-цены нигде в боте (фактчек 04.10: пример «Term 1 — 3,300» жил в системном промпте)
  for (const f of ['knowledge.md', 'prompts.js', 'templates.js', 'index.js', 'engine.js']) {
    const src = fs.readFileSync(require('path').join(__dirname, '../agents/answer-bot', f), 'utf8');
    const m = src.match(/1,700|3,300|5,000|Term 1 —/);
    if (m) problems.push(`${f}: старая терм-цена «${m[0]}»`);
  }
  return problems;
}

(async () => {
  const tp = templatesConsistent();
  console.log('=== шаблоны ↔ база:', tp.length ? '❌ ' + tp.join('; ') : '✅ цифры совпадают');
  if (tp.length) process.exitCode = 1;

  const quick = process.argv.includes('--quick');
  const rest = process.argv.includes('--rest');
  const onlyNew = process.argv.includes('--new');
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7); // --only=подстрока имени кейса
  const cases = only ? CASES.filter(c => c.name.includes(only)) : onlyNew ? CASES.filter(c => c.isNew)
    : quick ? CASES.filter((_, i) => i % 2 === 0) : rest ? CASES.filter((_, i) => i % 2 === 1) : CASES;
  let pass = 0, fail = 0;
  for (const c of cases) {
    let out = '';
    try { out = await (c.deep ? deepAnswer : answer)(c.q); }
    catch (e) { console.log(`\n=== ${c.name}: ❌ ОШИБКА: ${e.message}`); fail++; continue; }
    const ok = (() => { try { return c.check(out) && out.length > 40; } catch { return false; } })();
    ok ? pass++ : fail++;
    console.log(`\n=== ${c.name}: ${ok ? '✅' : '❌'}`);
    if (!ok) console.log(out);
    else console.log(process.argv.includes('--full') ? out : out.slice(0, 160) + '…'); // --full: весь ответ (для фактчека)
  }

  // Вижн-кейс: синтетический скриншот WhatsApp рисуется на лету (старая фикстура жила в /tmp и пропала — кейс молча не шёл)
  if (!quick && !rest && !onlyNew) {
    try {
      const { createCanvas } = require('canvas');
      const cv = createCanvas(720, 560), g = cv.getContext('2d');
      g.fillStyle = '#ECE5DD'; g.fillRect(0, 0, 720, 560);
      g.fillStyle = '#075E54'; g.fillRect(0, 0, 720, 90);
      g.fillStyle = '#fff'; g.font = 'bold 30px sans-serif'; g.fillText('Sara', 30, 58);
      g.font = '26px sans-serif';
      [[130, ['Hello! Welcome to AcroGym.', 'How can we help you?'], 1, '10:02'],
       [290, ['Hi! My daughter is 3 years old.', 'How much is it once a week?', 'And which group would she join?'], 0, '10:05']]
        .forEach(([y, lines, out, t]) => {
          const h = lines.length * 38 + 44, x = out ? 250 : 20;
          g.fillStyle = out ? '#DCF8C6' : '#fff'; g.fillRect(x, y, 450, h);
          g.fillStyle = '#111'; lines.forEach((l, i) => g.fillText(l, x + 20, y + 40 + i * 38));
          g.fillStyle = '#888'; g.font = '18px sans-serif'; g.fillText(t, x + 380, y + h - 12); g.font = '26px sans-serif';
        });
      const data = cv.toBuffer('image/jpeg').toString('base64');
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
