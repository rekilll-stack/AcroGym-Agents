# Canva Connect — настройка (Track D, автогенерация брендовых картинок)

Цель: бот генерит картинку из **реального брендового шаблона Canva** (точный
шрифт/стиль), подставляя текст + фото. Картинка = **черновик** в чат, постинг
вручную. Постинга в Instagram в коде нет.

Серверная часть уже готова (написана заранее):
- `agents/content-bot/canva.js` — клиент (OAuth+refresh, asset upload, autofill, export).
- `scripts/canva-auth.js` — разовая авторизация (PKCE, без веб-сервера).
- `agents/content-bot/canva-templates.example.json` — карта стилей → шаблоны/поля.

Осталось ввести данные аккаунта и проверить вживую. Шаги ниже.

---

## 1. Аккаунт Canva (Pro) + MFA
- На аккаунте включить **MFA** (требование для разработчиков).
- План **Pro** (для экспорта/генерации).

## 2. Developer Portal → интеграция
1. https://www.canva.com/developers/ → **Your integrations → Create an integration** → **Private** (для своей команды).
2. **Scopes** (включить и read, и write — раздельно):
   `asset:read asset:write design:meta:read design:content:read design:content:write brand_template:read brand_template:content:read`
3. **Redirect URL** — пока поставь любой валидный https, например:
   `https://admin.acrogym.org/canva/callback`
   (веб-страница не нужна — код скопируем из адресной строки браузера).
4. **Запросить dev-доступ к Autofill** — описать use case, напр.:
   > Internal tool for AcroGym (children's gymnastics, Doha). We autofill our
   > own brand templates with text and a photo to generate DRAFT social-media
   > images for manual posting. Low volume, single team account.
5. Сгенерировать **Client ID** + **Client Secret**.

## 3. Внести ключи на сервере (.env)
В `/home/admin/acrogym/.env` добавить (Client Secret — НЕ в чат, только тут):
```
CANVA_CLIENT_ID=...
CANVA_CLIENT_SECRET=...
CANVA_REDIRECT_URL=https://admin.acrogym.org/canva/callback
```

## 4. Разовая авторизация
```
cd /home/admin/acrogym
node scripts/canva-auth.js            # печатает ссылку — открой в браузере, разреши
# браузер уйдёт на ...?code=XXXX — скопируй XXXX
node scripts/canva-auth.js <code>     # сохранит refresh token (0600)
node scripts/canva-auth.js --check    # проверка: получает access token
```

## 5. Шаблоны Canva (дизайн — на стороне Canva)
Сделать 1–2 брендовых шаблона (Brand Template) с **именованными autofill-полями**:
- **Cover**: текстовое поле (заголовок), картинка (фон), опц. текст для таблетки.
- **Content**: текст (заголовок), картинка (фон), текст (абзац).

Узнать ID шаблона и точные имена полей:
```
# (после авторизации) — узнать поля шаблона:
node -e "require('dotenv').config({path:'.env'});require('./agents/content-bot/canva').getTemplateDataset('TEMPLATE_ID').then(d=>console.log(JSON.stringify(d,null,2)))"
```
Скопировать `canva-templates.example.json` → `canva-templates.json` и вписать
реальные `templateId` и имена полей.

## 6. Подключение к боту (делаю я после п.1–5)
🎨 в боте: выбор стиля (Cover/Content) → заголовок (можно ✨ сгенерировать, D.3)
→ для Content ещё абзац → (опц.) фото → `canva.generateFromTemplate()` → PNG в чат.
Если Canva недоступна/не настроена — фоллбек на встроенный движок.

---

🔴 Безопасность: Client Secret и refresh token — только в `.env` / `data/canva-tokens.json` (0600), не в чат, не в логи. Картинка = черновик, автопостинга нет.
