#!/data/data/com.termux/files/usr/bin/bash
# Установка MyPal на Android через Termux (F-Droid или GitHub-версия Termux, НЕ из Google Play).
# Запуск:  bash scripts/termux-setup.sh
set -e
echo "== MyPal: установка в Termux =="
pkg update -y
pkg install -y nodejs-lts git
node -e "const [a,b]=process.versions.node.split('.').map(Number); if (a<22||(a===22&&b<13)) { console.error('Нужен Node.js 22.13+, установлен '+process.version+'. Попробуй: pkg install nodejs'); process.exit(1) }"
# Нативных модулей нет: Bedrock работает через чистый JS (jsp-raknet), база — встроенный node:sqlite
npm install --no-audit --no-fund
termux-wake-lock 2>/dev/null || true   # чтобы Android не усыплял Termux, пока ты в Minecraft
cat <<'MSG'

Готово! Запуск:
  npm start                       — панель на http://localhost:3000 (открой в браузере телефона)
  HOST=0.0.0.0 PANEL_PASSWORD=секрет npm start   — чтобы открыть панель с другого устройства

Играешь на этом же телефоне в Bedrock?
  1. В мире: Настройки → Мультиплеер → «Видно игрокам в LAN», включи читы.
  2. В панели: Настройки → Minecraft → Издание: Bedrock, хост 127.0.0.1, порт 19132, вход: Microsoft.
  3. Подключи pal'а, введи код входа Microsoft (появится в панели), дай ему оператора: /op <имя бота>.
  4. Не закрывай Termux (уведомление «wake lock» должно висеть).
MSG
