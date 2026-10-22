#!/bin/bash
# 15.10.2026: приёмник броней корта для ChatGPT мимо Cloudflare (на acrogym.org CF режет ИИ-ботов 403).
# hook.acrogym.org/tennis → 127.0.0.1:8021/schedule/api/tennis (jarvis-schedule, проверка ключа там). Запуск: sudo bash этот_файл
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Запусти через sudo"; exit 1; }
CONF=$(readlink -f /etc/nginx/sites-enabled/hook.acrogym.org.conf)
BAK="/root/hook.acrogym.org.conf.bak-$(date +%Y%m%d-%H%M%S)"
cp -a "$CONF" "$BAK"
rollback() { cp -a "$BAK" "$CONF"; nginx -t && systemctl reload nginx; echo "ОТКАТИЛ, конфиг как был"; exit 1; }
if ! grep -q "location = /tennis" "$CONF"; then
  python3 - "$CONF" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
anchor = '    location /webhook/ {'
assert s.count(anchor) == 1, 'не нашёл location /webhook/'
block = '''    location = /tennis {   # 15.10.2026: ChatGPT → брони корта (теннис-агент), мимо Cloudflare
        limit_req zone=webhook_limit burst=20 nodelay;
        proxy_pass http://127.0.0.1:8021/schedule/api/tennis;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
'''
open(p, 'w').write(s.replace(anchor, block + anchor))
PY
  nginx -t || rollback
  systemctl reload nginx
fi
sleep 1
out=$(curl -s -X POST https://hook.acrogym.org/tennis -H 'Content-Type: application/json' -d '{}')
echo "проверка: $out"
echo "$out" | grep -q 'bad token' || rollback   # ждём ответ нашего приёмника «нет ключа», а не basic-auth n8n
echo "ГОТОВО: https://hook.acrogym.org/tennis работает. Бэкап: $BAK"
