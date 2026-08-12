#!/bin/bash
cd "$(dirname "$0")/.."
export NAME_SERVICE=NS2
export PYTHONUNBUFFERED=1
exec ./venv/bin/python bot.py
