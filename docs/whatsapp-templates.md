# WhatsApp Business — шаблоны на модерацию Meta

Черновики к Дню активации (Meta verification). Категория указана по правилам
Меты: **utility** — транзакционные (дешёвые), **marketing** — промо (дороже).
Переменные — в формате Меты `{{n}}`. Язык шаблонов: EN (основная аудитория).
RU-перевод приложен только для ревью Кириллом, на модерацию идёт EN.

---

## 1. `lead_first_reply` — utility
Первый ответ на заявку (если ушли за пределы 24ч-окна).

> Hi {{1}}! Thank you for your interest in AcroGym — the kids' gymnastics &
> acrobatics club at The Pearl, Doha. We'd love to invite {{2}} for a FREE
> trial class. Reply here and we'll find a time that works for you! 🤸

RU: «Здравствуйте, {{1}}! Спасибо за интерес к AcroGym… приглашаем {{2}} на
бесплатное пробное занятие — ответьте, и подберём время».
Переменные: {{1}} имя родителя, {{2}} имя ребёнка / "your child".

## 2. `trial_confirmation` — utility
> Hi {{1}}! Your trial class at AcroGym is confirmed: {{2}} at {{3}}.
> Address: The Pearl, Doha. Please arrive 10 minutes early — comfortable
> sportswear, water bottle, big smile! See you soon 🌟

Переменные: {{1}} имя, {{2}} дата, {{3}} время.

## 3. `trial_reminder` — utility
> Hi {{1}}! A friendly reminder: {{2}}'s trial class at AcroGym is tomorrow
> at {{3}}. If you need to reschedule, just reply to this message. 🤸

## 4. `launch_announcement` — marketing
> 🎉 AcroGym is opening on {{1}}! Gymnastics & acrobatics for kids 3–14 at
> The Pearl, Doha. You asked about our classes earlier — founding members
> get {{2}}. Book your child's spot: reply here or tap the link below.

Переменные: {{1}} дата открытия, {{2}} оффер (напр. "20% off the first month").
Кнопка: URL → acrogym.org.

## 5. `nurture_checkin` — marketing
Тач прогрева для «остывших» лидов (только после ручного первого контакта).

> Hi {{1}}! We're getting closer to opening day at AcroGym 🤸 Classes for
> ages 3–14 are filling up. Would {{2}} like to join the first groups?
> Reply and we'll reserve a spot — no payment needed yet.

---

### Примечания к подаче
- Все имена/поля — только переменными, никакого хардкода детских имён.
- Каждому шаблону нужен опт-аут: Мета сама добавляет для marketing; для
  utility достаточно ответной реплики.
- После одобрения — ID шаблонов вписать в `.env` (B6, День активации),
  структура рассылки уже готова в `shared/broadcast/` (throw-stub до активации).
