"""Smoke test: login Tele + resolve GROUP + forward tin 0 (hoặc ping text) để check nhóm."""
import asyncio
import os
import sys
from dotenv import load_dotenv
from telethon import TelegramClient

load_dotenv()

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

api_id = int(os.getenv('API_ID') or 0)
api_hash = (os.getenv('API_HASH') or '').strip()
phone = (os.getenv('PHONE') or '').strip().replace(' ', '')
group = (os.getenv('GROUP') or '').strip()
source = (os.getenv('SOURCE_USERNAME') or 'frezeit').strip().lstrip('@')
twofa = (
    os.getenv('TELEGRAM_2FA_PASSWORD')
    or os.getenv('TELEGRAM_PASSWORD')
    or ''
).strip()
digits = ''.join(c for c in phone if c.isdigit())
session = f'user_session_{digits}' if digits else 'user_session'


async def main():
    print(f'PHONE={phone} GROUP={group} SOURCE=@{source} session={session}', flush=True)
    client = TelegramClient(session, api_id, api_hash)
    await client.connect()
    if not await client.is_user_authorized():
        print('Chưa login — gửi OTP...', flush=True)
        sent = await client.send_code_request(phone)
        code = input('OTP: ').strip()
        try:
            await client.sign_in(phone=phone, code=code, phone_code_hash=sent.phone_code_hash)
        except Exception as e:
            if 'SessionPasswordNeeded' in type(e).__name__ or 'password' in str(e).lower():
                await client.sign_in(password=twofa or input('2FA: ').strip())
            else:
                raise
    me = await client.get_me()
    print(f'Login OK: {me.first_name} (@{me.username}) id={me.id}', flush=True)

    # Resolve group
    entity = None
    try:
        entity = await client.get_entity(int(group))
    except Exception as e:
        print(f'get_entity(int) fail: {e}', flush=True)
        async for d in client.iter_dialogs():
            ids = {d.id, getattr(d.entity, 'id', None)}
            if int(group) in ids or abs(int(group)) in {abs(x) for x in ids if isinstance(x, int)}:
                entity = d.entity
                break
    if not entity:
        raise RuntimeError(f'Không resolve được GROUP={group}')
    title = getattr(entity, 'title', None) or getattr(entity, 'username', None) or entity
    print(f'GROUP OK: {title} id={getattr(entity, "id", None)}', flush=True)

    # Load source + forward index 0 để check nhóm nhận được
    user = await client.get_entity(source)
    msgs = []
    async for m in client.iter_messages(user, limit=50):
        if m.sender_id == me.id:
            msgs.append(m)
    if len(msgs) < 1:
        async for m in client.iter_messages(user, limit=20):
            msgs.append(m)
    msgs = sorted(msgs, key=lambda m: m.id)
    print(f'SOURCE tin: {len(msgs)}', flush=True)
    if msgs:
        await client.forward_messages(entity, msgs[0], silent=True, drop_author=True)
        print('Đã forward tin index 0 vào nhóm — check Tele!', flush=True)
    else:
        await client.send_message(entity, '✅ Bot check nhóm OK (không có tin nguồn để forward)')
        print('Đã gửi ping text vào nhóm', flush=True)

    await client.disconnect()
    print('DONE', flush=True)


if __name__ == '__main__':
    asyncio.run(main())
