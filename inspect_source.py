import os
import sys
import asyncio
from dotenv import load_dotenv
from telethon import TelegramClient

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

load_dotenv()
phone = ''.join(c for c in (os.getenv('PHONE') or '') if c.isdigit())
api_id = int(os.getenv('API_ID'))
api_hash = os.getenv('API_HASH')

async def main():
    client = TelegramClient(f'user_session_{phone}', api_id, api_hash)
    await client.connect()
    user = await client.get_entity(os.getenv('SOURCE_USERNAME', 'frezeit'))
    msgs = []
    async for m in client.iter_messages(user, limit=20):
        msgs.append(m)
    msgs.sort(key=lambda x: x.id)
    print("=== SOURCE MESSAGES IN TELEGRAM ===")
    for i, m in enumerate(msgs):
        txt = m.text or m.message or ''
        print(f"Index [{i}] ID={m.id}:\n{txt}\n{'-'*30}")
    await client.disconnect()

if __name__ == '__main__':
    asyncio.run(main())
