#!/bin/bash
# 13.10 владелец: «повреждённые файлы — следи, как будут доступны, копируй тоже».
# Раз в день пробует скачать всё из data/mirror-skip-paths.txt: что Яндекс отдал — копируется в Google и уходит из списка, папки — если снова читаются.
# Тот же замок, что у ночного копирования: пока оно идёт — пропуск.
cd /home/admin/acrogym || exit 1
LOG=logs/mirror-recheck.log; RCL=/home/admin/bin/rclone; T=/tmp/claude-1000/mirror-recheck; mkdir -p $T
exec 9>data/.mirror-yadisk.lock
flock -n 9 || { echo "$(date '+%F %T') копирование идёт — проверка позже" >> $LOG; exit 0; }
[ -s data/mirror-skip-paths.txt ] || exit 0
grep -v '/$' data/mirror-skip-paths.txt > $T/files.txt; grep '/$' data/mirror-skip-paths.txt > $T/dirs.txt; : > $T/back.txt
echo "$(date '+%F %T') проверка: файлов $(wc -l < $T/files.txt), папок $(wc -l < $T/dirs.txt)" >> $LOG
if [ -s $T/files.txt ]; then
  $RCL copy yadisk: gdrive:YandexDisk-backup --files-from-raw $T/files.txt --no-traverse --transfers 12 --timeout 45s --contimeout 30s \
    --retries 1 --low-level-retries 1 --log-level INFO --log-file $T/run.log --max-duration 2h
  # вернулся = без ошибки в этом прогоне (скопирован или уже лежит на Google); недоделанное по лимиту времени остаётся в списке
  grep -oP 'ERROR : \K.+?(?=: Failed to copy)' $T/run.log | sort -u > $T/bad.txt
  if ! grep -q 'max transfer duration reached\|Max duration reached' $T/run.log; then grep -vxF -f $T/bad.txt $T/files.txt >> $T/back.txt; else grep -oP 'INFO  : \K.+?(?=: Copied \()' $T/run.log | sort -u >> $T/back.txt; fi
fi
while IFS= read -r d; do timeout 60 $RCL lsf --max-depth 1 "yadisk:${d%/}" >/dev/null 2>&1 && echo "$d" >> $T/back.txt; done < $T/dirs.txt
N=$(sort -u $T/back.txt | grep -c .)
if [ "$N" -gt 0 ]; then
  node scripts/mirror-skip.js --drop $T/back.txt >> $LOG 2>&1
  node -e "require('dotenv').config({path:'.env'});require('./shared/notify').sendToOwner('♻️ Яндекс снова отдал $N повреждённых файлов/папок — скопированы на Google (папки доберёт ночное копирование). В списке осталось: '+require('fs').readFileSync('data/mirror-skip-paths.txt','utf8').split('\n').filter(Boolean).length, { parse_mode: undefined }).then(()=>process.exit(0),()=>process.exit(1))"
fi
echo "$(date '+%F %T') вернулось: $N" >> $LOG
rm -f $T/run.log
