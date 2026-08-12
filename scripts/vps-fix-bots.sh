#!/bin/bash
APP="/var/www/bot-keo-nhom-bcr/bot-keo-nhom-bcr-main"
cd "$APP"
for f in scripts/run-*.sh; do sed -i 's/\r$//' "$f"; chmod +x "$f"; done
pkill -f 'venv/bin/python bot.py' 2>/dev/null || true
rm -f bot.lock bot_NS1.lock bot_NS2.lock
pm2 delete bot_sexy_1 bot_sexy_2 2>/dev/null || true
pm2 start scripts/run-bot-ns1.sh --name bot_sexy_1 --interpreter bash --cwd "$APP"
pm2 start scripts/run-bot-ns2.sh --name bot_sexy_2 --interpreter bash --cwd "$APP"
pm2 save
sleep 15
pm2 list
echo '--- bot1 ---'
tail -8 /root/.pm2/logs/bot-sexy-1-out.log
echo '--- bot2 ---'
tail -8 /root/.pm2/logs/bot-sexy-2-out.log
echo '--- err1 ---'
tail -5 /root/.pm2/logs/bot-sexy-1-error.log 2>/dev/null || true
echo '--- err2 ---'
tail -5 /root/.pm2/logs/bot-sexy-2-error.log 2>/dev/null || true
curl -s http://127.0.0.1:3201/api/occupied-tables; echo
