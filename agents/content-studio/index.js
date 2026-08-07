'use strict';
/**
 * Content Studio — Telegram-обвязка мульти-агентной студии.
 *
 * Боты по ролям в общей группе. Владелец кидает тему командой
 * `/студия <тема>` (или /studio, /пост, /post) → команда обсуждает вживую
 * (каждая реплика от своего бота), в конце Модератор даёт финальное
 * предложение с кнопками ✅ Делаем / ↩️ Переделать. По ✅ концепт уходит
 * в очередь на сборку content-bot (data/studio-approved.jsonl).
 *
 * LLM — через подписочный шим (Sonnet, $0 API), см. studio.js.
 *
 * Токены: config/studio-bots.json = { moderator, smm, photo, copy, critic, audience }.
 * Активируется, если есть МОДЕРАТОР + хотя бы один спикер; недостающие роли
 * просто не участвуют. Если модератора/спикеров нет — процесс живёт и раз в
 * 60с перечитывает конфиг, активируясь сам, как появятся токены.
 * (Добавил роль в уже активную студию? Нужен pm2 restart content-studio.)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const { createLogger } = require('../../shared/logger');
const { PERSONAS } = require('./personas');
const { runSession } = require('./studio');

const logger = createLogger('content-studio');

const CFG_PATH = path.join(__dirname, '../../config/studio-bots.json');
const APPROVED_LOG = path.join(__dirname, '../../data/studio-approved.jsonl');
const BUILD_DIR = path.join(__dirname, '../../data/studio-build'); // очередь на сборку для content-bot
const NOTIFY_DIR = path.join(__dirname, '../../data/studio-notify'); // приватный итог владельцу через content-bot
const WEEK_QUEUE_PATH = path.join(__dirname, '../../data/studio-week-queue.json'); // темы недели для последовательной сборки
const STATE_PATH = path.join(__dirname, '../../data/studio-state.json');
const PHOTOS_DIR = path.join(__dirname, '../../data/studio-photos'); // фото владельца для ручной сборки
const SCOUT_DIR = path.join(__dirname, '../../data/studio-scout'); // запросы скауту: подобрать фото из библиотеки
const SPEAKING = ['smm', 'photo', 'copy', 'critic', 'audience']; // порядок высказываний
// Подборка фото владельца: chatId → { dir, files:[пути], theme }. Копит присланные фото,
// пока владелец не нажмёт «✅ Одобрить и собрать»; тогда критики судят СЫРЫЕ фото → сборка.
const photoTray = new Map();

// Язык ПОДПИСИ поста (обсуждение всегда по-русски). Персистентно, по умолчанию русский.
function getState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) || {}; } catch { return {}; } }
function setState(patch) { try { fs.writeFileSync(STATE_PATH, JSON.stringify({ ...getState(), ...patch })); } catch (e) { /* ignore */ } }
function getLang() { return getState().lang === 'en' ? 'en' : 'ru'; }
function setLang(l) { setState({ lang: l }); }
const langLabel = (l) => (l === 'en' ? '🇬🇧 English' : '🇷🇺 Русский');

const OWNER_IDS = String(process.env.OWNER_CHAT_IDS || '216299177')
  .split(',').map((s) => Number(s.trim())).filter(Boolean);
const isOwner = (id) => OWNER_IDS.includes(Number(id));
const validTok = (t) => typeof t === 'string' && t.length >= 20;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
  catch { return null; }
}

function activate(tokens) {
  const speakers = SPEAKING.filter((k) => validTok(tokens[k]));
  const roleKeys = ['moderator', ...speakers];
  const bots = {};
  for (const k of roleKeys) bots[k] = new TelegramBot(tokens[k], { polling: k === 'moderator' });
  const mod = bots.moderator;
  // Меню команд (показывается по «/» в чате).
  mod.setMyCommands([
    { command: 'scout', description: '🔍 Подобрать фото из библиотеки под тему' },
    { command: 'next', description: '▶️ Собрать следующий пост из плана недели' },
    { command: 'post', description: '📝 Собрать пост по теме (авто-подбор фото)' },
    { command: 'brief', description: '🗓 Где взять план на неделю' },
    { command: 'english', description: 'Обсуждать на английском' },
    { command: 'russian', description: 'Обсуждать на русском' },
    { command: 'help', description: 'Как пользоваться студией' },
  ]).catch((e) => logger.warn({ e: e.message }, 'setMyCommands failed'));
  const running = new Set();       // chatId сессий в работе
  const lastProposal = new Map();  // chatId → финальное предложение
  const lastTopic = new Map();     // chatId → тема (для сборки content-bot)

  async function say(roleKey, chatId, text) {
    const p = PERSONAS[roleKey];
    try {
      await bots[roleKey].sendMessage(chatId, `${p.emoji} <b>${esc(p.name)}</b>\n${esc(text)}`,
        { parse_mode: 'HTML' });
    } catch (e) { logger.error({ e: e.message, roleKey }, 'send failed'); }
  }

  // Еженедельный брифинг стратегии от 📊 СММ в группу (данные content-bot + LLM).
  const TZ = process.env.TIMEZONE || 'Asia/Qatar';
  async function weeklyBriefing(targetChatId) {
    const chatId = targetChatId || getState().groupChatId;
    if (!chatId) { logger.warn('weekly briefing: группа ещё не известна (напиши что-нибудь в группе)'); return; }
    const dataDir = path.join(__dirname, '../../data');
    let competitors = '', plan = '';
    try { competitors = fs.readFileSync(path.join(dataDir, 'competitor-brief.md'), 'utf8').slice(0, 4000); } catch { /* нет данных */ }
    try { plan = fs.readFileSync(path.join(dataDir, 'content-plan.json'), 'utf8').slice(0, 2000); } catch { /* нет данных */ }
    // МОДЕЛЬ: планирует ОДИН заточенный СММ-агент (чисто и структурно), не 6-агентное обсуждение.
    await bots.smm.sendMessage(chatId, '📊 <b>СММ готовит план на неделю…</b>', { parse_mode: 'HTML' }).catch(() => {});
    const gen = require('../content-bot/llm').generateText;
    const SMM_PLAN_SYS =
      'Ты — СММ-стратег детского акро-зала AcroGym (Доха, премиальный молл Lagoona; акробатика для мальчиков и девочек 3+; ' +
      'отстройка от Olympic Stars (только девочки) и MyGym (генералист)). Готовишь ЧЁТКИЙ план контента на неделю. ' +
      'Структура строго: 🧭 Стратегия (угол против конкурентов, 2-3 строки) → Пиллары (3-4) → Хуки на вовлечение (2-3) → ' +
      'Чего избегать (2-3) → Cadence → 📅 План постов (4-5; каждый: [тег] тема + 1 строка «зачем»). ' +
      'Пиши по-русски, конкретно, без воды. Итоговый ПОСТ/подпись — на английском.';
    let proposal = '';
    try {
      proposal = String(await gen({ system: SMM_PLAN_SYS, maxTokens: 1500,
        user: `Данные.\nКОНКУРЕНТЫ (brief):\n${competitors || '(нет свежих)'}\n\nТЕКУЩИЙ ПЛАН:\n${plan || '(нет)'}\n\nДай план на неделю в указанной структуре.` }) || '').trim();
    } catch (e) { logger.error({ e: e.message }, 'weekly plan gen'); proposal = 'Не смог собрать план (LLM недоступен).'; }
    await bots.smm.sendMessage(chatId, `📊 <b>СММ — план на неделю</b>\n\n${esc(proposal).slice(0, 3800)}`, { parse_mode: 'HTML' }).catch(() => {});
    // План — в личку владельцу.
    try { fs.mkdirSync(NOTIFY_DIR, { recursive: true }); fs.writeFileSync(path.join(NOTIFY_DIR, `${Date.now()}.json`), JSON.stringify({ kind: 'plan', topic: 'План на неделю', proposal })); }
    catch (e) { logger.error({ e: e.message }, 'plan notify write failed'); }
    // Темы недели в очередь — собираем по ОДНОЙ в день.
    try {
      const raw2 = await gen({ system: 'Из плана недели выдели темы постов. Ответь ТОЛЬКО JSON-массивом строк (3-5), без пояснений.', user: `План:\n${proposal}\n\nJSON-массив тем постов.` });
      const m = String(raw2 || '').match(/\[[\s\S]*\]/);
      const themes = m ? JSON.parse(m[0]) : [];
      if (Array.isArray(themes) && themes.length) {
        fs.writeFileSync(WEEK_QUEUE_PATH, JSON.stringify({ createdAt: new Date().toISOString(), chatId, queue: themes.slice(0, 7).map((t) => ({ theme: String(t).slice(0, 300), done: false })) }));
        await bots.smm.sendMessage(chatId, `🗓 Темы недели в очередь: <b>${themes.length}</b>. Собираю по одной в день (10:00), финал — тебе в личку.`, { parse_mode: 'HTML' }).catch(() => {});
      }
    } catch (e) { logger.error({ e: e.message }, 'week queue extract failed'); }
    logger.info({ chatId }, 'weekly briefing done');
  }
  // Воскресный авто-план ОТКЛЮЧЁН (19.07.2026): неделю планирует content-bot в
  // личке (красивый формат + кнопки ✅). На его «✅ Утвердить план» темы придут
  // в studio-week-queue.json, а дневной крон ниже (10:00) соберёт по одной через
  // ревью. weeklyBriefing() оставлен как есть, но больше по расписанию не зовётся.

  // Последовательная сборка: раз в день берём ОДНУ тему из очереди недели → студия → финал в личку.
  async function buildNextPlanned(targetChatId) {
    let state; try { state = JSON.parse(fs.readFileSync(WEEK_QUEUE_PATH, 'utf8')); } catch { return false; }
    if (!state || !Array.isArray(state.queue)) return false;
    const next = state.queue.find((x) => !x.done);
    const chatId = targetChatId || state.chatId || getState().groupChatId;
    if (!chatId) { logger.warn('buildNextPlanned: нет группы'); return false; }
    if (!next) { await bots.moderator.sendMessage(chatId, '🗓 Все темы недели уже собраны. Новый план — в content-bot (кнопка 📅 → ✅ Утвердить), темы придут сюда автоматически.').catch(() => {}); return false; }
    next.done = true;
    try { fs.writeFileSync(WEEK_QUEUE_PATH, JSON.stringify(state)); } catch (e) { logger.error({ e: e.message }, 'week queue save'); }
    try { fs.mkdirSync(BUILD_DIR, { recursive: true }); fs.writeFileSync(path.join(BUILD_DIR, `${Date.now()}.json`), JSON.stringify({ theme: next.theme, chatId, at: new Date().toISOString() })); }
    catch (e) { logger.error({ e: e.message }, 'daily enqueue failed'); }
    await bots.moderator.sendMessage(chatId, `🗓 <b>По плану на сегодня:</b> «${esc(next.theme)}»\ncontent-bot собирает, команда отревьюит, финал — тебе в личку.`, { parse_mode: 'HTML' }).catch(() => {});
    logger.info({ theme: next.theme }, 'daily planned build enqueued');
    return true;
  }
  cron.schedule('0 10 * * *', () => { buildNextPlanned().catch((e) => logger.error({ e: e.message }, 'daily build cron')); }, { timezone: TZ });

  // ── РУЧНАЯ ПОДБОРКА ФОТО ВЛАДЕЛЬЦА ─────────────────────────────────────────
  // Владелец кидает свои фото в чат → копим → критики судят СЫРЫЕ фото → сборка из них.
  const trayKb = (tray) => ({ reply_markup: { inline_keyboard: [
    [{ text: `✅ Одобрить и собрать (${tray.files.length})`, callback_data: 'photos:review' }],
    [{ text: '🗑 Сбросить подборку', callback_data: 'photos:reset' }],
  ] } });
  function buildTrayKb(tray) { return trayKb(tray); }

  async function intakeOwnerPhoto(chatId, msg) {
    let tray = photoTray.get(chatId);
    if (!tray) { tray = { dir: path.join(PHOTOS_DIR, String(Date.now())), files: [], theme: null }; fs.mkdirSync(tray.dir, { recursive: true }); photoTray.set(chatId, tray); }
    if (msg.caption && !tray.theme) tray.theme = msg.caption.trim();
    // Скачиваем и добавляем фото (кап 4 — карусель). Лишние сверх 4 молча игнорим.
    if (tray.files.length < 4) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const link = await mod.getFileLink(fileId);
      const res = await fetch(link); if (!res.ok) throw new Error('photo download ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const fp = path.join(tray.dir, `p${tray.files.length + 1}.jpg`);
      fs.writeFileSync(fp, buf); tray.files.push(fp);
    }
    // ДЕБАУНС: фото из альбома приходят ОТДЕЛЬНЫМИ сообщениями → не спамим подтверждением
    // на каждое, а шлём ОДИН промпт через паузу, когда фото перестали сыпаться.
    if (tray._timer) clearTimeout(tray._timer);
    tray._timer = setTimeout(() => {
      tray._timer = null;
      const t = photoTray.get(chatId); if (!t) return;
      const head = t.files.length >= 4 ? '🖼 В подборке <b>4</b> фото (максимум для карусели).'
                                       : `🖼 В подборке: <b>${t.files.length}</b> фото (можно до 4).`;
      mod.sendMessage(chatId, `${head}${t.theme ? '' : ' Напиши тему поста текстом.'}\nЖми ✅, когда готов.`,
        { parse_mode: 'HTML', ...trayKb(t) }).catch(() => {});
    }, 2000);
  }

  function enqueueOwnerPhotos(chatId) {
    const tray = photoTray.get(chatId);
    if (!tray || !tray.files.length) return false;
    try {
      fs.mkdirSync(BUILD_DIR, { recursive: true });
      fs.writeFileSync(path.join(BUILD_DIR, `${Date.now()}.json`),
        JSON.stringify({ theme: tray.theme || 'AcroGym kids', chatId, photos: tray.files.slice(0, 4), at: new Date().toISOString() }));
    } catch (e) { logger.error({ e: e.message }, 'enqueue owner photos'); return false; }
    photoTray.delete(chatId); // подборка ушла в сборку (файлы почистит content-bot после успеха)
    return true;
  }

  async function reviewOwnerPhotos(chatId) {
    const tray = photoTray.get(chatId);
    if (!tray || !tray.files.length) { await mod.sendMessage(chatId, 'Подборка пуста — пришли фото 🙂').catch(() => {}); return; }
    if (!tray.theme) { await mod.sendMessage(chatId, '📝 Сначала напиши тему поста текстом, потом жми ✅.').catch(() => {}); return; }
    const gen = require('../content-bot/llm').generateText;
    const images = tray.files.slice(0, 6).map((f) => ({ data: fs.readFileSync(f).toString('base64'), media_type: 'image/jpeg' }));
    const PANEL = [
      { key: 'critic', emoji: '🔍', name: 'Критик', system: 'Ты — строгий контент-критик детского акро-зала AcroGym (Доха). Смотришь на ПРИСЛАННЫЕ ВЛАДЕЛЬЦЕМ фото для будущего поста: качество, кадр/композиция, читаемость, брендфит, безопасность и уважение к детям. По-русски, коротко.' },
      { key: 'audience', emoji: '👀', name: 'Зрители', system: 'Ты — фокус-группа родителей-подписчиков AcroGym (Доха). Смотришь на эти фото глазами родителя: зацепит ли, захочется ли записать ребёнка. По-русски, коротко.' },
      { key: 'smm', emoji: '📊', name: 'СММ', system: 'Ты — СММ-стратег AcroGym (Доха). Оцени эти фото для поста: подходят ли для продвижения/вовлечения/заявок. По-русски, коротко.' },
    ];
    await mod.sendMessage(chatId, `🔍 Критики смотрят твои <b>${tray.files.length}</b> фото по теме «${esc(tray.theme)}»…`, { parse_mode: 'HTML' }).catch(() => {});
    let allOk = true;
    for (const r of PANEL) {
      let verdict = '';
      try {
        verdict = String(await gen({ system: r.system, images,
          user: `Тема поста: «${tray.theme}». Годятся ли эти фото для поста? Ответь СТРОГО первым словом ДА или НЕТ, затем 1 короткое предложение почему.` }) || '').trim();
      } catch (e) { logger.error({ e: e.message, role: r.name }, 'photo review failed'); verdict = 'не смог оценить — засчитываю ДА'; }
      if (!(/^\s*да\b/i.test(verdict) || /засчитываю ДА/i.test(verdict))) allOk = false;
      if (bots[r.key]) await bots[r.key].sendMessage(chatId, `${r.emoji} <b>${r.name}</b>\n${esc(verdict)}`, { parse_mode: 'HTML' }).catch(() => {});
    }
    if (allOk) {
      await mod.sendMessage(chatId, '✅ Критики одобрили фото — собираю пост из них, финал пришлю тебе в личку.', { parse_mode: 'HTML' }).catch(() => {});
      enqueueOwnerPhotos(chatId);
    } else {
      await mod.sendMessage(chatId, '⚠️ У критиков есть вопросы к фото (см. выше). Собрать всё равно из них — или пришлёшь другие?',
        { reply_markup: { inline_keyboard: [
          [{ text: '✅ Всё равно собрать', callback_data: 'photos:build' }],
          [{ text: '🗑 Пришлю другие', callback_data: 'photos:reset' }],
        ] } }).catch(() => {});
    }
  }

  mod.on('message', async (msg) => {
    if (!msg || (msg.from && msg.from.is_bot)) return;   // игнор реплик самих ботов команды
    if (!isOwner(msg.from && msg.from.id)) return;        // только владелец
    const chatId = msg.chat.id;
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') setState({ groupChatId: chatId });
    // ── Приём ФОТО владельца (ручная подборка): копим до «✅ Одобрить и собрать».
    if (Array.isArray(msg.photo) && msg.photo.length) {
      await intakeOwnerPhoto(chatId, msg).catch((e) => logger.error({ e: e.message }, 'photo intake'));
      return;
    }
    const raw = (msg.text || '').trim();
    if (!raw) return;                                    // сервисные/пустые сообщения
    const low = raw.toLowerCase();
    const cmdWord = low.replace(/@[a-z0-9_]+$/i, '').trim(); // убрать @botname у команд в группе
    // Запоминаем группу студии — сюда пойдёт еженедельный брифинг.
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') setState({ groupChatId: chatId });
    // Помощь / список.
    if (/^\/(help|start|команды|помощь)$/i.test(cmdWord)) {
      await mod.sendMessage(chatId,
        '🎬 <b>Контент-студия</b> — цех ревью.\n' +
        '• Напиши <b>тему</b> — content-bot соберёт (авто-фото), команда отревьюит.\n' +
        '• 🖼 <b>Кинь свои фото</b> (до 4) + тему → критики оценят фото → соберём пост из них.\n' +
        '• 🔍 <code>/подбери &lt;тема&gt;</code> — скаут сам найдёт кадры в библиотеке и кинет на выбор.\n' +
        '• 🗓 План на неделю готовит <b>content-bot в личке</b> (кнопка 📅 → ✅ Утвердить) → темы придут сюда.\n' +
        '• /next — собрать следующий из плана · /english · /russian (пост всегда English)\n' +
        '• Финал всегда — тебе в личку с кнопкой публикации; 🛑 Стоп прервёт сборку.',
        { parse_mode: 'HTML' }).catch(() => {});
      return;
    }
    // Планёрку недели теперь ведёт content-bot (красивый формат + кнопки ✅ в личке).
    // Студия — только ревью. /brief лишь подсказывает, где взять план.
    if (/^\/?(брифинг|briefing|бриф|brief)$/i.test(cmdWord)) {
      await mod.sendMessage(chatId,
        '🗓 План на неделю теперь готовит <b>content-bot</b> — открой его в личке и нажми 📅 «План на неделю».\n' +
        'Там красивый формат и кнопка <b>✅ Утвердить план</b>. Как утвердишь — темы прилетят сюда, и команда соберёт по одной в день (10:00), финал — тебе в личку.\n\n' +
        'Здесь, в студии: напиши тему для разового поста или /next — собрать следующий из плана сейчас.',
        { parse_mode: 'HTML' }).catch(() => {});
      return;
    }
    // Собрать следующий пост из плана недели (ручной триггер вместо ожидания 10:00).
    if (/^\/?(next|след|следующий|дальше)$/i.test(cmdWord)) {
      await buildNextPlanned(chatId).catch(() => {});
      return;
    }
    // 🔍 Скаут: подобрать фото из библиотеки под тему → кандидаты в чат, владелец выбирает.
    const scoutM = raw.match(/^\/?(?:подбери|подбор|scout|скаут)(?:@\S+)?(?:\s+([\s\S]*))?$/i);
    if (scoutM) {
      const theme = (scoutM[1] || '').trim();
      if (!theme) { await mod.sendMessage(chatId, '🔍 Тема? Напр.: <code>/подбери первый кувырок</code>', { parse_mode: 'HTML' }).catch(() => {}); return; }
      try {
        fs.mkdirSync(SCOUT_DIR, { recursive: true });
        fs.writeFileSync(path.join(SCOUT_DIR, `${Date.now()}.json`), JSON.stringify({ theme, chatId, at: new Date().toISOString() }));
        await mod.sendMessage(chatId, `🔍 Скаут ищет фото под «${esc(theme)}» — скоро кину кандидатов в чат, отметишь нужные.`, { parse_mode: 'HTML' }).catch(() => {});
      } catch (e) { await mod.sendMessage(chatId, '⚠️ Не смог запустить скаут: ' + esc(e.message)).catch(() => {}); }
      return;
    }
    // Переключатель языка обсуждения: слово-токен или команда (/english, /russian).
    const wantEn = /^\/?(язык[:\s]+)?(англ\S*|english|eng|en)$/i.test(cmdWord) || low === '🇬🇧';
    const wantRu = /^\/?(язык[:\s]+)?(рус\S*|russian|ru)$/i.test(cmdWord) || low === '🇷🇺';
    if (wantEn || wantRu) {
      const l = wantEn ? 'en' : 'ru';
      setLang(l);
      await mod.sendMessage(msg.chat.id,
        `Язык обсуждения теперь: ${langLabel(l)}. (Итоговый пост всегда на английском 🇬🇧.) Пиши тему 🙂`);
      return;
    }
    // Активна подборка фото → входящий ТЕКСТ = тема для НЕЁ (а не авто-сборка из стока).
    if (photoTray.has(chatId) && !raw.startsWith('/')) {
      const tray = photoTray.get(chatId); tray.theme = raw;
      await mod.sendMessage(chatId, `📝 Тема принята: «${esc(raw)}». Фото в подборке: ${tray.files.length}. Жми ✅ Одобрить и собрать.`, buildTrayKb(tray)).catch(() => {});
      return;
    }
    // Тема = обычный текст (или /пост <тема>). МОДЕЛЬ: content-bot планирует+собирает, студия РЕВЬЮИТ готовое.
    let topic = raw;
    const cmd = raw.match(/^\/(?:студия|studio|пост|post)(?:@\S+)?(?:\s+([\s\S]*))?$/i);
    if (cmd) topic = (cmd[1] || '').trim();
    else if (raw.startsWith('/')) return;
    if (!topic) {
      await mod.sendMessage(chatId, 'Напиши тему поста обычным сообщением — content-bot соберёт, команда отревьюит 🙂');
      return;
    }
    // Без обсуждения-ради-плана: сразу в очередь на сборку → content-bot собирает → панель ревьюит → финал в личку.
    try {
      fs.mkdirSync(BUILD_DIR, { recursive: true });
      fs.writeFileSync(path.join(BUILD_DIR, `${Date.now()}.json`), JSON.stringify({ theme: topic, chatId, at: new Date().toISOString() }));
      await mod.sendMessage(chatId, `🎬 Принято: «${esc(topic)}».\ncontent-bot собирает пост, команда отревьюит, финал — тебе в личку.`, { parse_mode: 'HTML' });
    } catch (e) {
      logger.error({ e: e.message, chatId }, 'topic enqueue failed');
      await mod.sendMessage(chatId, `⚠️ Не смог поставить в очередь: ${esc(e.message)}`).catch(() => {});
    }
  });

  mod.on('callback_query', async (q) => {
    try {
      if (!isOwner(q.from && q.from.id)) return mod.answerCallbackQuery(q.id, { text: 'Судит только владелец 🙂' });
      const chatId = q.message.chat.id;
      if (q.data === 'studio:ok') {
        await mod.answerCallbackQuery(q.id, { text: 'Принято!' });
        const proposal = lastProposal.get(chatId) || '';
        const theme = lastTopic.get(chatId) || '';
        try {
          fs.appendFileSync(APPROVED_LOG, JSON.stringify({ at: new Date().toISOString(), chatId, theme, proposal }) + '\n');
        } catch (e) { logger.error({ e: e.message }, 'approved-log write failed'); }
        // Запрос на сборку для content-bot (он следит за этой папкой и собирает черновик в ЭТУ группу).
        try {
          fs.mkdirSync(BUILD_DIR, { recursive: true });
          fs.writeFileSync(path.join(BUILD_DIR, `${Date.now()}.json`),
            JSON.stringify({ theme, chatId, at: new Date().toISOString() }));
        } catch (e) { logger.error({ e: e.message }, 'build-request write failed'); }
        await mod.sendMessage(chatId,
          '✅ <b>Утверждено.</b> content-bot собирает черновик (фото + Canva) и пришлёт сюда — это ~1-2 минуты 🎨',
          { parse_mode: 'HTML' });
        logger.info({ chatId, theme }, 'proposal approved → build queued');
      } else if (q.data === 'studio:redo') {
        await mod.answerCallbackQuery(q.id, { text: 'Ок' });
        await mod.sendMessage(chatId,
          '↩️ Понял. Напиши, что поменять, и запусти снова: <code>/студия &lt;тема с правками&gt;</code>',
          { parse_mode: 'HTML' });
      } else if (q.data === 'photos:review') {
        await mod.answerCallbackQuery(q.id, { text: 'Зову критиков…' }).catch(() => {});
        await reviewOwnerPhotos(chatId);
      } else if (q.data === 'photos:build') {
        await mod.answerCallbackQuery(q.id, { text: 'Собираю' }).catch(() => {});
        if (enqueueOwnerPhotos(chatId)) await mod.sendMessage(chatId, '🎨 Собираю пост из твоих фото — финал пришлю в личку.').catch(() => {});
        else await mod.sendMessage(chatId, 'Подборка пуста 🙂').catch(() => {});
      } else if (q.data === 'photos:reset') {
        await mod.answerCallbackQuery(q.id, { text: 'Сброшено' }).catch(() => {});
        const tray = photoTray.get(chatId);
        if (tray) { try { fs.rmSync(tray.dir, { recursive: true, force: true }); } catch {} photoTray.delete(chatId); }
        await mod.sendMessage(chatId, '🗑 Подборка сброшена. Пришли новые фото, когда готов.').catch(() => {});
      }
    } catch (e) { logger.error({ e: e.message }, 'callback failed'); }
  });

  mod.on('polling_error', (e) => logger.warn({ e: e.message }, 'moderator polling_error'));
  logger.info({ owners: OWNER_IDS, speakers, missing: SPEAKING.filter((k) => !validTok(tokens[k])) },
    'Content-studio running ✅ (жду /студия <тема> в группе)');
}

function start() {
  const tokens = loadTokens();
  const ready = tokens && validTok(tokens.moderator) && SPEAKING.some((k) => validTok(tokens[k]));
  if (ready) { activate(tokens); return; }
  logger.warn({ cfg: CFG_PATH },
    'нет модератора и/или спикеров — студия СПИТ, перечитываю конфиг каждые 60с и активируюсь сам.');
  const timer = setInterval(() => {
    const t = loadTokens();
    if (t && validTok(t.moderator) && SPEAKING.some((k) => validTok(t[k]))) {
      clearInterval(timer);
      logger.info('токены найдены — активирую студию');
      activate(t);
    }
  }, 60000);
}

process.on('SIGTERM', () => { logger.info('SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { logger.info('SIGINT'); process.exit(0); });
process.on('uncaughtException', (err) => { logger.fatal({ err }, 'uncaught'); process.exit(1); });
process.on('unhandledRejection', (reason) => { logger.error({ reason }, 'unhandled rejection'); });

if (require.main === module) start();
module.exports = { start, loadTokens };
