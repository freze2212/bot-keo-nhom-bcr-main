#!/bin/bash
cd "$(dirname "$0")/.."
export ACCOUNT_INDEX=1
exec node --max-old-space-size=1536 -r dotenv/config servicePuppeteer/session.js
