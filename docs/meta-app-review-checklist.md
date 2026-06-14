# Meta: публикация приложения для боевых лидов (Часть B / Б2)

Чтобы реальные Instagram/FB лиды доставлялись, приложение нужно **опубликовать**.
Facebook не доставляет production-события leadgen, пока приложение Unpublished
(дословно из App→Webhooks: "No production data ... will be delivered unless the
app has been published"). В dev-режиме доходит только кнопка «Test».

Два РАЗНЫХ этапа → потом Publish. Идти по порядку.

---

## Наша сторона — ГОТОВО (ничего делать не надо)

- ✅ n8n-воркфлоу «AcroGym Meta Lead Ads Intake v2» активен
- ✅ Callback `https://hook.acrogym.org/webhook/meta-lead` верифицирован, поле `leadgen` Subscribed
- ✅ Страница AcroGym Qatar подписана на приложение (subscribed_apps = leadgen)
- ✅ Дотяжка (page-токен) → маппинг → канонная таблица → карточка в Assistant — проверено
- После публикации боевые лиды пойдут автоматически, без правок

---

## ЭТАП 1 — Business Verification (документы, без видео)

**Где:** business.facebook.com → Business Settings → **Security Center** →
Business Verification (Start verification).

**Что подготовить (название/адрес/телефон должны СОВПАДАТЬ во всех документах):**
- Юридическое название бизнеса AcroGym, адрес (The Pearl, Qatar), телефон
- **Официальный документ существования бизнеса** — для Катара обычно:
  - Commercial Registration (CR) / Trade License / Establishment card
- Иногда дополнительно: счёт за коммуналку / банковская выписка с названием+адресом бизнеса
- Подтверждение телефона/почты бизнеса (Meta пришлёт код)

**Срок:** ~1–3 рабочих дня (дольше, если попросят переслать документ).

---

## ЭТАП 2 — App Review на `leads_retrieval` (описание + видео)

**Где:** App Dashboard (AcroGym Leads) → **App Review → Permissions and Features**
→ у `leads_retrieval` нажать **Request / Get Advanced Access** → заполнить форму.

### 2a. Текст use case (готов, вставить как есть, EN)

```
AcroGym is a children's gymnastics center in The Pearl, Qatar. We run
Instagram and Facebook Lead Ads with an Instant Form so parents can request
a trial class for their child.

Our app uses leads_retrieval to receive the "leadgen" webhook for our own
Page's lead forms and to fetch the submitted lead's fields (parent name,
phone number, child's age). The lead is forwarded to our internal CRM — an
n8n workflow that records it in our private Google Sheet and notifies our
staff via a private Telegram bot — so our team can call the parent back to
schedule the class.

We only access leads from our own Page's ad forms. The data is used solely
to contact the parent who submitted the form. We do not share or sell it.
```

### 2b. Сценарий демо-видео (скринкаст, 1–2 минуты)

> Записать экран (любой «запись экрана»). В dev-режиме реальный лид не придёт,
> поэтому демонстрируем через кнопку **Test** у поля `leadgen` — она доходит до
> карточки и показывает весь поток.

Шаги для записи:
1. Покажи приложение и Страницу: App Dashboard → видно «AcroGym Leads», затем
   страница AcroGym Qatar и Instant Form «AcroGym Trial Lead».
2. App → Webhooks → объект Page → у поля **`leadgen`** нажми **Test**.
3. Переключись на Telegram (Assistant bot) — покажи, как появилась **карточка лида**
   (имя, телефон, возраст, Source: Instagram ad).
4. (Опционально) покажи строку в Google-таблице.
5. Голос/подпись: «When a parent submits our Instagram lead form, our app
   retrieves the lead via leads_retrieval and notifies our staff to call them
   back to book a class.»

Ассистент поможет: перед записью подготовит чистую витрину и подскажет тайминг.

### 2c. Privacy Policy

Уже указан в Basic Settings (страница политики acrogym.org). Проверь, что ссылка живая.

**Срок App Review:** обычно 1–5 рабочих дней; каждый отказ-с-правками = +дни,
поэтому видео и описание делаем аккуратно с первого раза.

---

## ЭТАП 3 — Publish

После одобрения: App Dashboard → **Publish** → переключить приложение в **Live**.

Затем сообщить ассистенту «опубликовано» — он сразу прогонит проверку
(реальный лид / Create lead → витрина → карточка).

---

## Важно
- Это трек владельца (аккаунт/бизнес в Meta). Ассистент в консоль Facebook доступа
  не имеет и подать ревью за владельца не может — но готовит все материалы и
  помогает с демо.
- До публикации труба готова и ждёт; тест — только кнопкой «Test».
