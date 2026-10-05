'use strict';

// Готовые (утверждённые владельцем) тексты для мгновенной отправки клиентам.
// Без LLM — мгновенно и дословно. Меняются здесь, действуют сразу после рестарта.
// Все цифры обязаны совпадать с knowledge.md (сверяет scripts/test-answer-bot.js).

const TEMPLATES = {
  prices: {
    label: { ru: '💰 Прайс (все цены)', en: '💰 Price list (all prices)' },
    text:
      'Here are our prices! 🧡\n\n' +
      '📅 Monthly plan — fixed price, covers 30 days from your start date:\n\n' +
      '   1×/week — 550\n' +
      '   2×/week — 1,100\n' +
      '   3×/week — 1,500\n\n' +
      '✨ Renewal bonus: renew your monthly plan on the day it ends — save 5% on the next month\n\n' +
      '🤸 Getting started & extras:\n\n' +
      '   🌟 First class — 100 QAR, credited toward your plan if you continue right after\n' +
      '   🎫 Single class — 250 QAR\n' +
      '   👤 Personal training — 300 QAR per session (pack of 10: 2,700)\n' +
      '   👥 Two children together — 400 QAR per session (pack of 10: 3,600)\n\n' +
      '💝 Good to know:\n\n' +
      '   👨‍👩‍👧‍👦 15% off for the 3rd child from the same family\n' +
      '   💳 Payment by bank transfer or Fawran — just send us the screenshot\n\n' +
      'All prices are in QAR. Would you like me to help choose the best option ' +
      'for your schedule? 😊',
  },
  welcome: {
    label: { ru: '👋 Приветствие нового лида', en: '👋 Welcome a new lead' },
    // Текст утверждён владельцем 06.09 (тот же, что lead-helper welcomeDraft).
    text:
      'Hello! 👋 This is AcroGym — thank you for your interest! 🧡\n\n' +
      "We're open at Lagoona Mall, 1st floor, Doha — classes are running now! 🤸\n\n" +
      'We have classes for kids aged 1.5 to 16 in small groups matched by age, and adult ' +
      'classes for 18+ too. The first class is 100 QAR — if you continue, it counts ' +
      'toward your package.\n\n' +
      'Would you like me to find a time for your child this week? 😊',
  },
  register: {
    label: { ru: '📝 Просьба зарегистрироваться', en: '📝 Ask to register' },
    text:
      'Thank you for your interest in AcroGym! 🤸\n\n' +
      "To book your child's first class, please complete our quick registration form:\n" +
      '👉 acrogym.org/register\n\n' +
      "It takes about 3 minutes and covers everything we need — your child's details and " +
      'our terms. Registration is required before the first class.\n\n' +
      "Once you're done, we'll confirm your class time on WhatsApp. See you at AcroGym, " +
      'Lagoona Mall! 🧡',
  },
  firstclass: {
    label: { ru: '🤸 Приглашение на первое занятие', en: '🤸 Invite to first class' },
    text:
      'The best way to start is our first class — 100 QAR 🤸 It is a full 50-minute class ' +
      'in the group matched to your child’s age, and after class the coach will share ' +
      'feedback with you.\n\n' +
      'And the good news: if you continue right after the first class, the 100 QAR is ' +
      'credited toward your monthly plan!\n\n' +
      'Registration takes 3 minutes: acrogym.org/register — which days suit you best? 🧡',
  },
  bring: {
    label: { ru: '🎒 Что взять с собой', en: '🎒 What to bring' },
    text:
      'Here is what to bring for the class 🤸\n\n' +
      '   👕 Comfortable sportswear\n' +
      '   🧦 Non-slip grip socks (shoes off before the mat)\n' +
      '   💧 A water bottle\n' +
      '   🎀 Long hair tied up, and no jewellery or watches\n\n' +
      'Please arrive 10 minutes early. See you at Lagoona Mall, 1st Floor! 🧡',
  },
  freeze: {
    label: { ru: '❄️ Правила заморозки/пропусков', en: '❄️ Freeze & missed classes' },
    text:
      'If your child has to miss a class, just let our admin know at least 24 hours ' +
      'in advance 🧡 We record the absence and extend your plan: up to 1 week per ' +
      'paid month.\n\n' +
      "A class cancelled with less than 24 hours' notice, or a no-show, counts as " +
      'used. 😊',
  },
  payment: {
    label: { ru: '💳 Как считается оплата', en: '💳 How payment works' },
    text:
      "Thank you for asking — it's actually very simple! 🧡\n\n" +
      '   🤸 First class — 100 QAR. If you continue right after it, this amount is ' +
      "credited toward your plan — so it's not an extra cost 😊\n\n" +
      '   📅 The monthly plan has a fixed price and covers 30 days from your start ' +
      "date — it isn't tied to calendar months, so you never pay for days before " +
      'you join and the price is the same every time.\n\n' +
      '   ✨ Renew on the day your plan ends and you save 5% on the next month.\n\n' +
      'Payment is easiest by bank transfer or Fawran — please send us the ' +
      'screenshot. Would you like me to send the exact price for your schedule? 😊',
  },
  renewal: {
    label: { ru: '🔁 Продление −5%', en: '🔁 Renewal −5%' },
    text:
      'A little bonus for you 🧡 If you renew your monthly plan on the day it ends, ' +
      'you save 5% on the next month:\n\n' +
      '   1×/week — 522.5 instead of 550\n' +
      '   2×/week — 1,045 instead of 1,100\n' +
      '   3×/week — 1,425 instead of 1,500\n\n' +
      'Shall I reserve the same days for the next month? 😊',
  },
  holidays: {
    label: { ru: '🗓 Каникулы', en: '🗓 Holidays' },
    text:
      'Here are our breaks this season 🗓\n\n' +
      '   ❄️ Winter break: 18 Dec – 3 Jan — classes resume on 4 January\n' +
      '   🌸 Spring break: 8 – 20 March — classes resume on 21 March\n\n' +
      'The season runs until 24 June — the last week of classes is 18–24 June ' +
      "(your group's last class depends on its day). 🤸",
  },
  twice: {
    label: { ru: '💪 Почему 2 раза в неделю', en: '💪 Why 2× a week' },
    text:
      'Once a week is a lovely start 🧡 Many families add a second day, because ' +
      'children learn through repetition — with shorter gaps between classes, ' +
      'skills stick and confidence grows noticeably faster.\n\n' +
      'And it is the same price per class: 550 at 1×/week vs 1,100 at 2×/week ' +
      '(3×/week is 1,500 — the best value per class).\n\n' +
      'Would you like me to suggest a second day that fits your schedule? 😊',
  },
};

module.exports = { TEMPLATES };
