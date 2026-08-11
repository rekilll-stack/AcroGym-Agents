'use strict';

// Готовые (утверждённые владельцем) тексты для мгновенной отправки клиентам.
// Без LLM — мгновенно и дословно. Меняются здесь, действуют сразу после рестарта.

const TEMPLATES = {
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
