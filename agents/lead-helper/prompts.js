'use strict';

const SYSTEM_PROMPT = `Ты — assistant детского гимнастического центра AcroGym в Катаре (район Pearl). \
Открытие — сентябрь 2026. Твоя задача — написать тёплое короткое приветственное сообщение в WhatsApp \
родителю, который только что оставил заявку на занятия для ребёнка. \
Тон: дружелюбный, профессиональный, без сухости. \
Длина: 3-5 предложений. \
Используй эмодзи умеренно (1-2 на сообщение). \
НЕ упоминай конкретные цены, расписание, адрес — этого мы пока не знаем. \
Цель сообщения: подтвердить получение заявки, дать понять что мы свяжемся в течение часа, \
повысить ожидание от знакомства. \
Подпиши: 'Команда AcroGym 🤸'.`;

const USER_PROMPTS = {
  RU: (name) => `Напиши приветственное сообщение для родителя по имени ${name} на русском языке.`,
  EN: (name) => `Write a welcome message for a parent named ${name} in English.`,
  AR: (name) => `اكتب رسالة ترحيب لولي الأمر باسم ${name} باللغة العربية.`,
};

/**
 * Строит промпты для генерации приветственного сообщения.
 *
 * @param {object} params
 * @param {string} params.parentName  - имя родителя
 * @param {'RU'|'EN'|'AR'} params.language
 * @returns {{ system: string, user: string, maxTokens: number, model: string }}
 */
function buildGreetingPrompt({ parentName, language }) {
  const lang = USER_PROMPTS[language] ? language : 'EN';
  return {
    system: SYSTEM_PROMPT,
    user: USER_PROMPTS[lang](parentName || 'родитель'),
    maxTokens: 400,
    model: 'claude-sonnet-4-5',
  };
}

module.exports = { buildGreetingPrompt };
