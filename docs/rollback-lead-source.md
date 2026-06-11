# Откат Agent 1 на старую Google-форму (аварийный)

**Когда применять:** лид-труба сломалась (n8n / nginx / канонная таблица), а лиды идут — бот должен снова читать старую Google-форму.

1. Открой `/home/admin/acrogym/.env` (`nano .env`), блок «Google Sheets»:
2. **Раскомментируй** пару старой формы: `GOOGLE_SHEET_ID=1SL94orhjzIsUa86-…` и `GOOGLE_SHEET_RESPONSES_TAB=Form Responses 1`
3. **Закомментируй** активную канонную пару: `GOOGLE_SHEET_ID=1U3SVscd_…` и `GOOGLE_SHEET_RESPONSES_TAB=Leads`
4. `pm2 restart lead-helper`
5. Проверь лог: `tail -f /home/admin/acrogym/logs/lead-helper-out.log` — ждать строку `sheets ok` (≤60 сек). Готово: Agent 1 на старой форме.

Код обратно-совместим (у строк старой формы нет Lead UID — дедуп сам падает на номера строк), БД откатывать не нужно. Возврат на канонную — те же шаги наоборот.
