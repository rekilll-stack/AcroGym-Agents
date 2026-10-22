#!/bin/bash
# Зеркало Яндекс.Диска → Google Drive (владелец 11.10.2026: «боюсь потерять всё на Яндексе»).
# sync с --backup-dir: удалённое или заменённое на Яндексе НЕ пропадает с Google, а уезжает в YandexDisk-backup-deleted/<дата>.
# 13.10: свой OAuth-клиент владельца (проект почты) вместо общего rclone — у общего кончилась квота; со scope drive.file старая папка YandexDisk-mirror новому клиенту не видна, поэтому новое имя.
LOG=/home/admin/acrogym/logs/mirror-yadisk.log
exec 9>/home/admin/acrogym/data/.mirror-yadisk.lock
flock -n 9 || { echo "$(date '+%F %T') прошлый запуск ещё идёт — пропуск" >> "$LOG"; exit 0; }
echo "$(date '+%F %T') старт" >> "$LOG"
# живой счётчик в боте: база (что уже на Google) + новое закреплённое сообщение; дальше крон раз в минуту правит его по rc-статистике
(cd /home/admin/acrogym && node scripts/mirror-live.js --start >> "$LOG" 2>&1)
touch /home/admin/acrogym/data/mirror-skip.txt
/home/admin/bin/rclone sync yadisk: gdrive:YandexDisk-backup \
  --exclude-from /home/admin/acrogym/data/mirror-skip.txt \
  --backup-dir "gdrive:YandexDisk-backup-deleted/$(date +%F)" \
  --fast-list --transfers 12 --checkers 16 --drive-chunk-size 64M --rc --rc-addr 127.0.0.1:5572 --rc-no-auth \
  --order-by size,ascending --timeout 45s --contimeout 30s \
  --retries 1 --low-level-retries 1 --stats 15m --stats-one-line --stats-log-level NOTICE \
  --log-level NOTICE --log-file "$LOG" --max-duration 20h --cutoff-mode soft  # 13.10 вечер: серверы хранения Яндекса на части файлов принимают запрос и молчат — ждать 45 с, без повторов, 12 потоков, чтобы зависшие не держали очередь; # 13.10: Яндекс отдаёт часть файлов с ошибкой «no more reliable hosts» — короткие таймауты, сначала мелкие файлы, не дольше 20 ч за запуск; недокачанное доберёт следующая ночь
rc=$?
echo "$(date '+%F %T') конец, код $rc" >> "$LOG"
# итог запуска владельцу (сколько скопировано, что Яндекс не отдал); упал сам отчёт (например, слетел доступ к Google) — красный сигнал
cd /home/admin/acrogym && node scripts/mirror-skip.js >> "$LOG" 2>&1  # 13.10 владелец: повреждённые (Яндекс не отдаёт) больше не копировать
node scripts/mirror-live.js --final --rc=$rc >> "$LOG" 2>&1; node scripts/mirror-progress.js --final --rc=$rc >> "$LOG" 2>&1
if [ $? -ne 0 ]; then
  node -e "require('dotenv').config({path:'.env'});require('./shared/notify').sendToOwner('🔴 Зеркало Яндекс.Диска → Google Drive не прошло (код $rc). Лог: logs/mirror-yadisk.log', { parse_mode: undefined }).then(()=>process.exit(0),()=>process.exit(1))"
fi
exit $rc
