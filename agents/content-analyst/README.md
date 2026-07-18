# Content Analyst (Agent — «Аналитик контента»)

Читает статистику постов Instagram, считает что сработало, и превращает это в
конкретные подсказки владельцу и для content-bot («делай больше рабочего»).

## Статус: движок готов и протестирован; ждёт живой источник данных

- ✅ `analyze.js` — расчёт (охват, вовлечённость = interactions/reach, сохранения,
  разбивка Reels vs посты, топ по вовлечённости) + LLM-разбор (3 блока: что
  сработало / что постить больше / частота). Источник данных инжектируется.
- ✅ `report.js` — Telegram-отчёт (HTML) владельцу.
- ✅ Проверено: `node scripts/demo-content-analyst.js` (1 реальный пост + 2 образца).
- ⏳ **НЕ сделано (ждёт сентября / решения владельца):**
  - `graph.js` — клиент Instagram Graph API (Meta, БЕСПЛАТНО). Пишем и тестируем
    ТОЛЬКО когда есть токен (иначе вслепую). Metricool API — платный (Advanced
    €43/мес), НЕ используем.
  - `index.js` — еженедельный крон (напр. пн 09:30 Asia/Qatar): fetch → analyze →
    sendToOwner → записать инсайты в бриф content-bot (research/plan вход).
  - Регистрация в pm2 + в watchdog WATCHED.

## Что нужно для активации (бесплатный путь)

Instagram Graph API от Meta по аккаунту `acrogymqatar` (IG business, привязан к
FB-странице `1139954045869591`). В `.env`:
- `META_GRAPH_TOKEN` — долгоживущий токен (System User в Business Settings =
  бессрочный; либо 60-дн Page token с refresh) с правами `instagram_basic`,
  `instagram_manage_insights`, `pages_read_engagement`, `pages_show_list`.
- `IG_BUSINESS_ID` — ID бизнес-аккаунта Instagram (из FB-страницы).

У владельца уже есть Meta-приложение (в .env есть `WHATSAPP_ACCESS_TOKEN`) —
скорее всего можно переиспользовать, добавив продукт Instagram Graph API.

## Метрики Instagram Graph (per-media insights)
`reach`, `saved`, `likes`, `comments`, `shares`, `total_interactions`, `views`
(набор зависит от типа: IMAGE/CAROUSEL_ALBUM vs REELS — у Reels свои поля).
Field-схему сверить на актуальной версии Graph API при написании `graph.js`.

_Обновлено 18.07.2026 — движок собран в сессии «делаем агентов»._
