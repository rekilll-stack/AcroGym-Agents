'use strict';

// Готовые (утверждённые владельцем) тексты для мгновенной отправки клиентам.
// Без LLM — мгновенно и дословно. Меняются здесь, действуют сразу после рестарта.

const TEMPLATES = {
  prices: {
    label: '💰 Прайс (все цены)',
    text:
      'Here are our prices! 🧡\n\n' +
      '💎 Term plan — most popular, best value. The price is fixed for the ' +
      'whole term, whichever weekdays you choose:\n\n' +
      '   1×/week — Term 1: 1,700 · Term 2: 1,100 · Term 3: 1,500\n' +
      '   2×/week — Term 1: 3,300 · Term 2: 1,900 · Term 3: 3,000\n' +
      '   3×/week — Term 1: 5,000 · Term 2: 2,900 · Term 3: 4,500\n\n' +
      'Per class it works out to about 100–110 QAR 😊\n\n' +
      '📅 Monthly plan — fixed price every month:\n\n' +
      '   1×/week — 550\n' +
      '   2×/week — 1,100\n' +
      '   3×/week — 1,650\n\n' +
      '🤸 Getting started & extras:\n\n' +
      '   🌟 First class — 100 QAR, credited toward your first package\n' +
      '   🎫 Single class — 250 QAR\n' +
      '   👤 Personal training — 300 QAR (one child) · 400 QAR (two children)\n\n' +
      '💝 Good to know:\n\n' +
      '   👨‍👩‍👧‍👦 15% off for the 3rd child from the same family\n' +
      '   🗓 Starting mid-month or mid-term? You only pay for the classes remaining\n\n' +
      'All prices are in QAR, payment at the gym. Would you like me to help ' +
      'choose the best option for your schedule? 😊',
  },
  welcome: {
    label: '👋 Приветствие нового лида',
    text:
      'Hello! 👋 This is AcroGym — thank you for your interest! 🧡\n\n' +
      "We're excited to welcome you to our brand-new gymnastics center — we open on " +
      'September 1st at Lagoona Mall, Doha! 🤸\n\n' +
      'We have classes for kids aged 2 to 16, in small groups matched by age — and adult ' +
      'classes for 18+ too! A class costs around 100 QAR — come and see how you love it!\n\n' +
      'Would you like me to book a spot for the first week of September? 😊',
  },
  register: {
    label: '📝 Просьба зарегистрироваться',
    text:
      'Thank you for your interest in AcroGym! 🤸\n\n' +
      "To book your child's first class, please complete our quick registration form:\n" +
      '👉 acrogym.org/register\n\n' +
      "It takes about 3 minutes and covers everything we need — your child's details and " +
      'our terms. Registration is required before the first visit.\n\n' +
      "Once you're done, we'll confirm your class time on WhatsApp. See you at AcroGym, " +
      'Lagoona Mall! 🧡',
  },
  freeze: {
    label: '❄️ Правила заморозки/пропусков',
    text:
      "We don't deduct money for missed classes — instead we offer a freeze, so nothing " +
      'is lost 🧡 On the term plan you can freeze up to 2 weeks per term, and on the ' +
      'monthly plan up to 1 week per month; the paid period is simply paused and added ' +
      'at the end.\n\n' +
      'Please just let our admin know at least 24 hours in advance — a class cancelled ' +
      "with less than 24 hours' notice counts as used. 😊",
  },
  firstclass: {
    label: '🤸 Приглашение на первое занятие',
    text:
      'The best way to start is our first class — 100 QAR 🤸 It is a full class in the ' +
      'group matched to your child’s age, with our professional coaches. And the good ' +
      'news: the 100 QAR is credited toward your first package when you sign up!\n\n' +
      'Registration takes 3 minutes: acrogym.org/register — would you like me to note ' +
      'your preferred days? 🧡',
  },
  payment: {
    label: '💳 Как считается оплата',
    text:
      "Thank you for asking — it's actually very simple! 🧡\n\n" +
      '   🤸 First class — 100 QAR. If you decide to continue, this amount is ' +
      "credited toward your first package — so it's not an extra cost 😊\n\n" +
      '   📅 Then you choose a plan — monthly or full term. The monthly price ' +
      "always stays the same: it's calculated on the average number of classes " +
      'per month, so whether a month has 9 classes or 8, the price never changes.\n\n' +
      '   🗓 Starting mid-month? No problem — you only pay for the classes ' +
      'remaining until the end of that month, and from the next month the ' +
      'regular price applies. You never pay for classes before your start date.\n\n' +
      'Payment is made at the gym. Would you like me to send the exact prices ' +
      'for your schedule? 😊',
  },
  termpitch: {
    label: '💎 Почему терм выгоднее',
    text:
      'Our term plan is the most popular option and the best value 🧡 The price is fixed ' +
      'for the whole term whichever days you choose, and per class it works out to about ' +
      '100–110 QAR — versus 125 QAR on the monthly plan and 250 QAR pay-as-you-go.\n\n' +
      'Plus the freeze option is bigger on the term plan: up to 2 weeks per term. Would ' +
      'you like me to send the exact term prices for your schedule? 😊',
  },
};

module.exports = { TEMPLATES };
