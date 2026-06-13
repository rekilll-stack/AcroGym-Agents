# Instagram/Meta Lead Ads → AcroGym труба (Часть B, Б1 — настройка Meta-стороны)

Инструкция для владельца. Делается один раз, руками — это то, что я (ассистент)
сделать за тебя не могу (вход в Facebook, согласие на доступ). Когда закончишь
шаги 1–3 и подтвердишь — я соберу воркфлоу в n8n и подключу к твоей форме.

Секреты (App ID, App Secret) **вводи прямо в n8n**, в чат не присылай.

---

## Шаг 1. Создать Facebook App

1. Зайди на **https://developers.facebook.com/** под аккаунтом, у которого есть
   доступ к рекламной Странице AcroGym.
2. Верхнее меню → **My Apps** → **Create App**.
3. Тип приложения — **Business** (если спросит use case — выбери вариант с
   «Facebook Login» / «Other»). Назови, напр. `AcroGym Leads`.
4. После создания ты на странице приложения (App Dashboard).
5. **Возьми App ID** — он вверху страницы.
6. **App Secret**: слева **App settings → Basic → App Secret → Show** (попросит
   пароль FB). Это два секрета, которые понадобятся в n8n (шаг 3).
7. На той же странице **Basic**:
   - **App Domains**: добавь `hook.acrogym.org`
   - **Privacy Policy URL**: ссылку на политику конфиденциальности сайта
     (нужна Meta; для теста подойдёт страница политики acrogym.org)
   - Сохрани (**Save changes**).

## Шаг 2. Добавить вход и указать redirect URI

1. На App Dashboard слева **Add Product** (или «+»):
   - добавь **Facebook Login for Business** (для OAuth-входа)
   - добавь **Webhooks** (n8n подпишется на лиды через него)
2. Слева **Facebook Login for Business → Settings**.
3. В поле **Valid OAuth Redirect URIs** вставь ровно эту строку и сохрани:
   ```
   https://hook.acrogym.org/rest/oauth2-credential/callback
   ```
4. Убедись, что ты **админ этого приложения** (App roles → Roles) и **админ
   рекламной Страницы** — без этого тестовые лиды не пройдут.
   App можно оставить в режиме **Development** — для ТЕСТОВЫХ лидов этого хватает
   (боевые лиды включим позже, после одобрения `leads_retrieval`).

## Шаг 3. Создать Instant Form (саму форму заявки)

Форму делают на Странице / в Ads Manager. Простой путь — через Страницу:

1. Открой свою **рекламную Страницу** → инструменты для лидов / **Forms Library**
   (Lead Forms / Instant Forms). Либо при создании Lead-объявления в Ads Manager —
   там же кнопка создать форму.
2. Создай новую **Instant Form**. В разделе вопросов добавь:
   - **Full name** (полное имя) — стандартное поле
   - **Phone number** (телефон) — стандартное поле, Meta его префиллит
   - **Custom question → Short answer**, текст вопроса: **Child's age**
     (возраст ребёнка). ⚠️ Без этого вопроса колонка «Child Age» в таблице
     будет пустой.
3. Сохрани и **опубликуй** форму (не оставляй черновиком). Запомни:
   - на какой **Странице** форма
   - **название формы**

## Шаг 4. Подключить OAuth в n8n

1. Открой **https://hook.acrogym.org/** → войди (basic-auth `acrogym` + твой
   пароль; затем твой логин n8n).
2. Слева **Credentials → Create credential** → найди
   **«Facebook Lead Ads OAuth2 API»**.
3. Впиши:
   - **Client ID** = твой **App ID** (из шага 1)
   - **Client Secret** = твой **App Secret** (из шага 1)
4. n8n покажет **OAuth Redirect URL** — сверь, что это
   `https://hook.acrogym.org/rest/oauth2-credential/callback` (та же, что в шаге 2).
5. Нажми **«Connect my account» / «Sign in with Facebook»** → войди в Facebook →
   **разреши** все запрошенные доступы (страницы, лиды). Credential должен стать
   **зелёным/Connected**.

---

## Что подтвердить мне после шагов 1–4

Напиши в чат (без секретов):
- «App создан, OAuth в n8n подключён (зелёный)»
- название **Страницы** и **Instant Form**, которые выбрать в узле

После этого я:
- соберу отдельный Meta-воркфлоу (маппинг в ту же канонную таблицу,
  `lead_uid = "meta_" + leadgen_id`, `Source = instagram_lead_ads`,
  `Client Type = 🆕 New client – Instagram ad`),
- выберу твою Page + Form, покажу собранное ДО активации,
- активирую (n8n подпишет Страницу на лиды) и проверю, что website-поток жив,
- прогоним тест через **Meta Lead Ads Testing Tool** → строка в таблице →
  карточка в Assistant → проверка, что повтор того же лида не двоит витрину.

Боевые лиды (Б2) включим **только** после твоего сигнала об одобрении
`leads_retrieval` в App Review.
