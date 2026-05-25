# AcroGym Agents 🤸

Система автоматизации для детского гимнастического центра **AcroGym** (Катар, район Pearl).  
Открытие — **сентябрь 2026**.

---

## Что это

Монорепозиторий Node.js-агентов, которые автоматизируют обработку заявок, коммуникацию с клиентами и внутреннюю аналитику. Каждый агент — независимый процесс, управляемый через PM2. Общая шина — SQLite + shared-модули.

---

## Архитектура

```
acrogym/
├── agents/                  # Каждый агент — отдельная папка
│   └── lead-helper/         # Агент #1: обработка новых заявок
│       ├── index.js         # Точка входа, логика агента
│       └── prompts.js       # Промпты для Claude
│
├── shared/                  # Общие модули для всех агентов
│   ├── db.js                # SQLite (better-sqlite3)
│   ├── telegram.js          # Telegram Bot API
│   ├── notify.js            # Абстракция канала уведомлений владельца
│   ├── sheets.js            # Google Sheets API
│   ├── claude.js            # Claude API с retry
│   ├── logger.js            # pino логгер (файл + stdout)
│   └── language.js          # Определение языка по имени (RU/EN/AR)
│
├── config/
│   ├── pm2.config.js        # PM2 ecosystem config
│   └── google-service-account.json  # (не в git)
│
├── data/
│   └── acrogym.db           # SQLite база (не в git)
│
├── logs/                    # Логи агентов (не в git)
├── .env                     # Секреты (не в git)
└── .env.example             # Шаблон переменных
```

**Принцип**: каждый агент читает `.env` и shared-модули, пишет в общую БД, уведомляет владельца через `shared/notify.js`.

---

## Быстрый старт

### 1. Установка зависимостей

```bash
cd /home/admin/acrogym
npm install
```

### 2. Заполнить секреты

```bash
cp .env.example .env
nano .env  # вставить токены и ключи
```

Положить `google-service-account.json` в `config/`.

### 3. Запуск через PM2

```bash
# Запустить всех агентов
pm2 start config/pm2.config.js

# Сохранить конфиг (чтобы пережил ребут)
pm2 save
```

### 4. Управление

```bash
pm2 list                    # статус всех агентов
pm2 logs lead-helper        # логи в реальном времени
pm2 logs lead-helper --lines 100  # последние 100 строк
pm2 restart lead-helper     # перезапуск
pm2 stop lead-helper        # остановка
pm2 monit                   # интерактивный мониторинг
```

---

## Добавление нового агента

1. Создай папку `agents/<agent-name>/`
2. Создай `agents/<agent-name>/index.js` по шаблону:

```js
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { createLogger }  = require('../../shared/logger');
const { sendToOwner }   = require('../../shared/notify');

const logger = createLogger('<agent-name>');

async function start() {
  logger.info('<agent-name> запускается');
  // ... логика агента
}

process.on('SIGTERM', () => process.exit(0));
process.on('uncaughtException', async (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  await sendToOwner(`🚨 <agent-name> упал: <code>${err.message}</code>`).catch(() => {});
  process.exit(1);
});

start().catch(err => { logger.fatal({ err }); process.exit(1); });
```

3. Добавь запись в `config/pm2.config.js` (см. закомментированный шаблон).
4. Запусти: `pm2 start config/pm2.config.js`

---

## Переменные окружения

| Переменная | Где брать |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather в Telegram |
| `OWNER_CHAT_ID` | @userinfobot или из update.message.chat.id |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `GOOGLE_SHEET_ID` | URL таблицы: `docs.google.com/spreadsheets/d/<ID>/` |
| `GOOGLE_SHEET_RESPONSES_TAB` | Название листа в таблице |
| `GOOGLE_SERVICE_ACCOUNT_PATH` | Путь к JSON, скачанному из Google Cloud Console |
| `TIMEZONE` | `Asia/Qatar` (UTC+3, без перехода на летнее время) |
| `POLL_INTERVAL_SECONDS` | Частота опроса Google Sheets (60 = раз в минуту) |
| `REMINDER_HOURS` | Через сколько часов слать напоминание (2) |

---

## Roadmap агентов

| # | Агент | Статус | Описание |
|---|---|---|---|
| 1 | `lead-helper` | ✅ **Готов** | Опрос заявок, генерация приветствий, напоминания |
| 2 | `deduplication` | ⏳ Планируется | Чистка дублей в Google Sheets |
| 3 | `pre-launch-nurture` | ⏳ Планируется | Прогрев лидов серией сообщений до открытия |
| 4 | `content-agent` | ⏳ Планируется | Генерация постов и подписей для Instagram |
| 5 | `morning-digest` | ⏳ Планируется | Утренняя сводка: новые лиды, статусы, задачи дня |
| 6 | `funnel-dashboard` | ⏳ Планируется | Дашборд воронки (Sheets / Notion) |
| 7 | `instagram-dm-agent` | ⏳ Планируется | ИИ-ответы в Instagram Direct (Meta API) |
| 8 | `progress-reports` | ⏳ После in2 | Месячные отчёты родителям о прогрессе ребёнка |
| 9 | `churn-warning` | ⏳ После in2 | Early warning: риск отток клиентов |
| 10 | `coach-replacement` | ⏳ После in2 | Автоматическая замена тренеров при отмене занятий |
| 11 | `form-to-in2-bridge` | ⏳ После in2 API | Синхронизация заявок из форм в систему in2 |

> **in2** — CRM/система управления занятиями (интеграция запланирована после получения API-доступа)

---

## База данных

SQLite (`data/acrogym.db`) — единый источник истины. Автоматически создаётся при первом запуске.

Ключевые таблицы:
- `leads` — все заявки, статусы обработки
- `logs` — журнал событий агентов (дублирует файловые логи)

Индексы: `status`, `parent_phone`.
