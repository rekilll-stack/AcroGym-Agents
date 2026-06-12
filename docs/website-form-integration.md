# AcroGym — Website Lead Form Integration / Подключение формы сайта к лид-трубе

> For the website developer. RU version below. / Версия на русском — ниже.

---

## EN

### Integration method

The site is static: its code lives in a GitHub repo and is edited directly —
there is no site builder (no Tilda/Wix). So no builder "Embed" widgets and no
iframe wrappers: **paste the form block straight into the HTML of the target
page/section**, as native markup styled like the rest of the page.

A static site has no backend of its own, so the form will post directly from
the browser — that's exactly the "conscious decision" case from the
Authentication warning below. Agree on it with the owner (the token is rotatable).

### Endpoint

```
POST https://hook.acrogym.org/webhook/acrogym-lead
```

### Authentication

Every request must carry the header:

```
x-webhook-token: <TOKEN_PROVIDED_SEPARATELY>
```

The token value is **not** in this file — the owner will hand it to you personally.
Missing or wrong token → **403** (rejected before any processing).

> ⚠️ **Keep the token out of client-side JavaScript if you can.** Anything in the
> page source is public. Best practice: the form posts to your site's backend,
> and the backend forwards the request (with the token) to the endpoint above.
> If you must post directly from the browser, tell the owner — the token is
> rotatable, but exposure should be a conscious decision.

### Fields

| Field       | Required | Notes                                                            |
|-------------|----------|------------------------------------------------------------------|
| `name`      | ✅ yes   | Parent's first name. Max 120 chars. Alias accepted: `parent_name` |
| `phone`     | ✅ yes   | Any human format — we normalize server-side. Alias: `parent_phone` |
| `child_age` | optional | Free text/number, max 20 chars. Alias: `age`                      |
| `source`    | optional | Defaults to `website_form`. Leave it out unless told otherwise    |

**Phone formats that all work** (everything normalizes to `97450009999`):

```
+974 5000 9999      → 97450009999
974-5000-9999       → 97450009999
50009999            → 97450009999   (8-digit local, country code added)
0 5000 9999         → 97450009999   (leading zeros stripped)
```

Non-Qatar international numbers: digits are kept as-is (e.g. `+7 916 123-45-67` → `79161234567`).
Spaces, dashes, parentheses — all fine, we strip non-digits.

### Content-Type

Both tested and supported:

- `application/json`
- `application/x-www-form-urlencoded`

### Responses

| Code | Body                                              | Meaning                          |
|------|---------------------------------------------------|----------------------------------|
| 200  | `{"ok":true,"lead_uid":"<uuid>"}`                 | Lead accepted                    |
| 400  | `{"ok":false,"error":"phone is required"}` (or `name is required`) | Missing required field |
| 403  | n8n auth error body                               | Missing/wrong `x-webhook-token`  |
| 503  | nginx error page                                  | Rate limit hit — retry in ~1s    |

### Test it yourself with curl (before publishing the form)

Success (expects 200 + lead_uid):

```bash
curl -i -X POST https://hook.acrogym.org/webhook/acrogym-lead \
  -H 'Content-Type: application/json' \
  -H 'x-webhook-token: <TOKEN_PROVIDED_SEPARATELY>' \
  -d '{"name":"Test Dev","phone":"+974 5000 0000","child_age":"6"}'
```

Missing phone (expects 400):

```bash
curl -i -X POST https://hook.acrogym.org/webhook/acrogym-lead \
  -H 'Content-Type: application/json' \
  -H 'x-webhook-token: <TOKEN_PROVIDED_SEPARATELY>' \
  -d '{"name":"Test Dev"}'
```

Wrong token (expects 403):

```bash
curl -i -X POST https://hook.acrogym.org/webhook/acrogym-lead \
  -H 'Content-Type: application/json' \
  -H 'x-webhook-token: wrong' \
  -d '{"name":"Test Dev","phone":"50000000"}'
```

> Please tell the owner before/after you run test submissions so the test
> leads can be cleaned out of the pipeline.

### Expected visitor experience

- Submit via async `fetch`/XHR — **no page reload**.
- On 200: show **"Thank you, we'll be in touch soon!"**
- On any non-200: show a generic "Something went wrong, please try again"
  (don't surface raw error bodies to visitors).
- Disable the submit button while the request is in flight. Accidental
  double-submits are deduplicated on our side, but one click = one request
  is still good manners.

### Rate limit

**10 requests/second per IP** (small burst allowed). Exceeding it returns
**503** from nginx. A normal human filling a form will never hit this; only
relevant if you script tests in a loop.

### Problems / questions

Contact the owner directly.

---

## RU

### Способ встраивания

Сайт статический: его код лежит в GitHub-репозитории и правится напрямую —
никакого конструктора (Tilda/Wix) нет. Поэтому никаких Embed-обёрток
конструкторов и iframe: **вставить блок в HTML нужной страницы/секции** —
как родную разметку, оформленную в стиле страницы.

У статического сайта нет своего бэкенда, поэтому форма будет слать запрос
прямо из браузера — это тот самый «осознанный» случай из предупреждения в
разделе «Аутентификация»; согласуй с владельцем (токен ротируемый).

### Endpoint

```
POST https://hook.acrogym.org/webhook/acrogym-lead
```

### Аутентификация

Каждый запрос обязан нести заголовок:

```
x-webhook-token: <TOKEN_PROVIDED_SEPARATELY>
```

Значения токена в этом файле **нет** — владелец передаст лично.
Нет токена / кривой токен → **403** (отбой до какой-либо обработки).

> ⚠️ **По возможности не свети токен в клиентском JavaScript** — всё, что в
> исходнике страницы, публично. Правильно: форма шлёт на бэкенд сайта, бэкенд
> с токеном пересылает на endpoint выше. Если будешь слать прямо из браузера —
> предупреди владельца: токен ротируемый, но это должно быть осознанное решение.

### Поля

| Поле        | Обязательно | Примечания                                                  |
|-------------|-------------|-------------------------------------------------------------|
| `name`      | ✅ да       | Имя родителя, до 120 символов. Алиас: `parent_name`         |
| `phone`     | ✅ да       | Любой человеческий формат — нормализуем сами. Алиас: `parent_phone` |
| `child_age` | нет         | Текст/число до 20 символов. Алиас: `age`                    |
| `source`    | нет         | По умолчанию `website_form` — не передавай без надобности   |

**Форматы телефона — всё это прокатит** (нормализуется в `97450009999`):

```
+974 5000 9999  /  974-5000-9999  /  50009999  /  0 5000 9999
```

Не-катарские международные номера: цифры сохраняются как есть.
Пробелы, дефисы, скобки — не проблема.

### Content-Type

Протестированы оба: `application/json` и `application/x-www-form-urlencoded`.

### Ответы

200 `{"ok":true,"lead_uid":"<uuid>"}` — принято · 400 — нет обязательного поля ·
403 — токен · 503 — rate-limit (повторить через секунду).

Примеры curl — в EN-секции выше (1:1).

> Перед/после тестовых отправок предупреди владельца — тестовые лиды надо
> вычищать из трубы.

### Поведение для посетителя

Тихий `fetch` без перезагрузки страницы. На 200 — **"Thank you, we'll be in
touch soon!"**. На не-200 — нейтральное "Something went wrong, please try
again". Кнопку блокировать на время запроса; случайные дубли мы дедупим
на своей стороне.

### Rate-limit

**10 запросов/сек с одного IP**, при превышении — **503** от nginx. Живой
человек с формой в это не упрётся; актуально только для скриптовых тестов.

### Проблемы / вопросы

Напрямую владельцу.
