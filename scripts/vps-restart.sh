#!/bin/bash
set -e
APP="/var/www/bot-keo-nhom-bcr/bot-keo-nhom-bcr-main"
cd "$APP"
chmod +x scripts/run-*.sh 2>/dev/null || true
pm2 delete ecosystem.config.production 2>/dev/null || true
rm -f bot.lock bot_NS1.lock bot_NS2.lock

pm2 delete session_sexy_1 session_sexy_2 bot_sexy_1 bot_sexy_2 2>/dev/null || true

pm2 restart server_sexy --update-env 2>/dev/null || \
  pm2 start server.js --name server_sexy \
    --node-args="--max-old-space-size=1536" \
    --interpreter-args="-r dotenv/config" \
    --max-memory-restart 1536M --cwd "$APP"

pm2 start scripts/run-session-ns1.sh --name session_sexy_1 \
  --interpreter bash --max-memory-restart 1536M --cwd "$APP"

pm2 start scripts/run-session-ns2.sh --name session_sexy_2 \
  --interpreter bash --max-memory-restart 1536M --cwd "$APP"

pm2 start scripts/run-bot-ns1.sh --name bot_sexy_1 \
  --interpreter bash --cwd "$APP"

pm2 start scripts/run-bot-ns2.sh --name bot_sexy_2 \
  --interpreter bash --cwd "$APP"

pm2 save
sleep 45
pm2 list
echo '--- occupied ---'
curl -s http://127.0.0.1:3201/api/occupied-tables; echo
echo '--- bot1 ---'
grep -E 'GROUP tu|NAME_SERVICE|WAIT BÀN|ĐANG Ở|hô' /root/.pm2/logs/bot-sexy-1-out.log | tail -8
echo '--- bot2 ---'
grep -E 'GROUP tu|NAME_SERVICE|WAIT BÀN|ĐANG Ở|hô|ERROR' /root/.pm2/logs/bot-sexy-2-out.log | tail -8
echo '--- session1 ---'
grep -E 'ACCOUNT|NHẬP =>|ĐANG Ở|API NOTIFY|active_table' /root/.pm2/logs/session-sexy-1-out.log | tail -8
echo '--- session2 ---'
grep -E 'ACCOUNT|NHẬP =>|ĐANG Ở|API NOTIFY|active_table' /root/.pm2/logs/session-sexy-2-out.log | tail -8
