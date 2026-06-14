# Meta App Review — чтобы боевые лиды доставлялись (Часть B / Б2)

## Почему это нужно (коротко)

Facebook **по своему правилу не доставляет реальные события leadgen, пока приложение
не опубликовано (Live)**. Дословно из App → Webhooks:

> "Apps will only be able to receive test webhooks sent from the dashboard while the
> app is unpublished. No production data, including from app admins, developers or
> testers, will be delivered unless the app has been published."

Поэтому в Development-режиме доходит **только** кнопка «Test» на дашборде, а
«Create lead» в Testing Tool и реальные лиды из рекламы — **нет**. Чтобы они пошли,
приложение надо **опубликовать**, а для публикации с доступом к лидам нужен
**App Review на `leads_retrieval`**.

## Наша сторона (готово, ничего делать не надо)

- ✅ n8n-воркфлоу «AcroGym Meta Lead Ads Intake v2» активен
- ✅ Callback `https://hook.acrogym.org/webhook/meta-lead` верифицирован, поле `leadgen` Subscribed
- ✅ Страница AcroGym Qatar подписана на приложение (`subscribed_apps` = leadgen)
- ✅ Дотяжка лида (page-токен), маппинг, запись в канонную таблицу, карточка в Assistant — проверены
- Как только приложение опубликуют — реальные лиды пойдут автоматически, без правок

## Что сделать владельцу (в developers.facebook.com, приложение AcroGym Leads)

1. **Business Verification** (если ещё не пройдена): App → Settings / Business
   portfolio → Security Center → пройти верификацию бизнеса (паспорт/документы
   компании). Часто требуется для advanced-доступа. Может занять дни.

2. **App Review → Permissions and Features**: запросить **Advanced Access** для:
   - `leads_retrieval` (главное)
   - `pages_show_list`, `pages_read_engagement` (если попросят advanced)
   На каждое — короткое описание use case: «Мы получаем лиды из Instagram/Facebook
   Lead Ads нашего детского гимнастического центра и отправляем их в наш внутренний
   CRM (n8n → Telegram), чтобы администратор связался с родителем».

3. **Demo-видео (screencast)** — Meta почти всегда требует. Записать экран:
   создать лид в Lead Ads Testing Tool → показать, что он приходит в нашу систему
   (карточка в Telegram). Ассистент поможет снять/подготовить, когда понадобится.

4. **Privacy Policy URL** — уже указан в Basic Settings (страница политики acrogym.org).

5. После одобрения — **Publish** приложения (переключить в Live на странице Publish).

6. Сообщить ассистенту «опубликовано» — он сразу прогонит проверку: реальный лид
   (Create lead или тест-реклама) → витрина → карточка.

## Важно

- Это **трек владельца** (его аккаунт/бизнес в Meta) — ассистент в консоль Facebook
  доступа не имеет и App Review за него подать не может.
- Срок — на стороне Meta (обычно несколько дней, иногда дольше при верификации бизнеса).
- До публикации труба полностью готова и ждёт; проверять её можно кнопкой «Test»
  (она доходит до карточки).
