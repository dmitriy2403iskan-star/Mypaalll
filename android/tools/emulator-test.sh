#!/usr/bin/env bash
# Проверка APK в эмуляторе: Node запускается, панель отвечает, HTTPS к API работает.
set -u
APK="$1"
adb install -r "$APK"
adb shell am start -n com.mypal.app/.MainActivity
adb forward tcp:3000 tcp:3000
ok=0
for i in $(seq 1 120); do
  if curl -sf http://127.0.0.1:3000/api/settings > /dev/null; then ok=1; echo "Панель отвечает через $((i * 2)) c"; break; fi
  sleep 2
done
echo '----- node.log'
adb shell run-as com.mypal.app cat files/node.log || true
[ "$ok" = 1 ] || { echo 'ОШИБКА: панель не ответила'; exit 1; }

echo '----- /api/pals'
curl -sf http://127.0.0.1:3000/api/pals || { echo 'ОШИБКА: /api/pals'; exit 1; }
echo
echo '----- HTTPS из Node (ожидаем ответ API с кодом 401, а не ошибку TLS/DNS):'
out=$(curl -s -X POST http://127.0.0.1:3000/api/providers/openai/test)
echo "$out"
echo "$out" | grep -qE 'HTTP 40[0-9]' || { echo 'ОШИБКА: HTTPS из Node не работает'; exit 1; }
echo 'ВСЁ OK'
