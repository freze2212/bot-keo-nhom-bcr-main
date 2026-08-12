import os
import sys
import json
import re
import sqlite3
import schedule
import time
import random
import atexit
import ctypes
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from telethon import TelegramClient
from telethon.errors import (
    PasswordHashInvalidError,
    PhoneCodeEmptyError,
    PhoneCodeExpiredError,
    PhoneCodeInvalidError,
    SessionPasswordNeededError,
)
from telethon.tl.types import InputPeerChannel, InputPeerChat, Channel, Chat

# Windows terminal: tranh crash khi in tieng Viet
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

# Load environment variables (path cố định — PM2 wrapper có thể đổi cwd)
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))


def log(msg):
    print(msg, flush=True)

def lock_file_path():
    ns = (os.getenv('NAME_SERVICE') or 'NS1').strip().upper() or 'NS1'
    return f'bot_{ns}.lock'


def ensure_single_instance():
    """Mỗi NAME_SERVICE một lock — cho phép bot_sexy_1 + bot_sexy_2 chạy song song."""
    lock_path = lock_file_path()
    if os.path.exists(lock_path):
        try:
            with open(lock_path, encoding='utf-8') as f:
                old_pid = int(f.read().strip())
            if is_process_running(old_pid):
                log(f"[ERROR] Bot {lock_path} da chay o PID {old_pid}. Tat bot cu roi chay lai.")
                sys.exit(1)
        except (ValueError, OSError):
            pass
    with open(lock_path, 'w', encoding='utf-8') as f:
        f.write(str(os.getpid()))


def release_lock():
    try:
        os.remove(lock_file_path())
    except OSError:
        pass


def is_process_running(pid):
    if pid <= 0:
        return False
    if sys.platform == 'win32':
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if handle:
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def configure_sqlite_session(telegram_client):
    session = telegram_client.session
    if hasattr(session, '_cursor'):
        session._cursor()
        if getattr(session, '_conn', None):
            session._conn.execute('PRAGMA busy_timeout=30000')


async def run_session_with_retry(telegram_client, group_entity, max_retries=5):
    for attempt in range(max_retries):
        try:
            await daily_schedule(telegram_client, group_entity)
            return
        except sqlite3.OperationalError as e:
            if 'locked' in str(e).lower() and attempt < max_retries - 1:
                wait = 2 * (attempt + 1)
                log(f"[WARN] Session bi khoa, thu lai sau {wait}s... ({attempt + 1}/{max_retries})")
                await asyncio.sleep(wait)
            else:
                raise

# Data structure to store posts
POSTS_FILE = 'posts.json'

# Image directories
FIXED_IMAGES_DIR = 'images/fixed'
WINCAI_IMAGES_DIR = 'images/wincai'
LOSECAI_IMAGES_DIR = 'images/losecai'
WINCON_IMAGES_DIR = 'images/wincon'
LOSECON_IMAGES_DIR = 'images/losecon'
TIE_IMAGES_DIR = 'images/tie'

RESULT_IMAGE_DIRS = {
    'wincai': WINCAI_IMAGES_DIR,
    'losecai': LOSECAI_IMAGES_DIR,
    'wincon': WINCON_IMAGES_DIR,
    'losecon': LOSECON_IMAGES_DIR,
    'tie': TIE_IMAGES_DIR,
}
IMAGE_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.webp', '.gif')
RESULT_TIME_SLOT = '11:00'

# Result probabilities
WIN_PROBABILITY = 0.70  # 70%
LOSE_PROBABILITY = 0.30  # 30%

sent_slots = set()
# Luồng Tele tối giản: 1) báo bàn  2) hô Con/Cái  3) ảnh kết quả — chạy liên tục

TZ = timezone(timedelta(hours=7))  # GMT+7 (Việt Nam)
SCHEDULE_INTERVAL = 5
SCHEDULE_START_HOUR, SCHEDULE_START_MINUTE = 0, 0
SCHEDULE_END_HOUR, SCHEDULE_END_MINUTE = 23, 55

raw_api_id = (os.getenv('API_ID') or '').strip()
if raw_api_id and raw_api_id.isdigit():
    api_id = int(raw_api_id)
else:
    api_id = 0  # Se duoc kiem tra khi connect telegram

api_hash = (os.getenv('API_HASH') or '').strip()
phone = (os.getenv('PHONE') or '').strip().replace(' ', '')
twofa_password = (
    os.getenv('TELEGRAM_2FA_PASSWORD')
    or os.getenv('TELEGRAM_PASSWORD')
    or os.getenv('TWO_FA_PASSWORD')
    or ''
).strip()

def session_name_from_phone(phone_number):
    digits = ''.join(c for c in (phone_number or '') if c.isdigit())
    return f'user_session_{digits}' if digits else 'user_session'

SESSION_NAME = session_name_from_phone(phone)


def get_group_env_value():
    """NS1 → GROUP_NS1, NS2 → GROUP_NS2, fallback GROUP."""
    ns = (os.getenv('NAME_SERVICE') or '').strip().upper()
    if ns == 'NS1':
        return (os.getenv('GROUP_NS1') or os.getenv('GROUP') or '').strip()
    if ns == 'NS2':
        return (os.getenv('GROUP_NS2') or os.getenv('GROUP') or '').strip()
    return (os.getenv('GROUP') or '').strip()


def get_name_service():
    return (os.getenv('NAME_SERVICE') or 'NS1').strip().upper() or 'NS1'


# ID hoặc username nhóm (có thể là @tennhom hoặc ID số)
group = os.getenv('GROUP')
source_username = (os.getenv('SOURCE_USERNAME') or 'house4179').strip() or 'house4179'
log(f"GROUP tu .env: {get_group_env_value()} | NAME_SERVICE={get_name_service()}")
log(f"Session: {SESSION_NAME} | PHONE tu .env: {phone}")
log(f"SOURCE_USERNAME tu .env/fallback: {source_username}")


client = None

# BotFather bot — hô / báo bàn / ảnh vào GROUP (có thể nhiều ID)
TOKEN_BOT = (os.getenv('TOKEN_BOT') or '').strip().strip('"\'')
# 1 = gửi hô bằng Bot API (TOKEN_BOT); 0 = gửi bằng userbot PHONE như cũ
HO_VIA_BOT = (os.getenv('HO_VIA_BOT') or '1').strip().lower() not in ('0', 'false', 'no')


def normalize_chat_id(value):
    raw = str(value or '').strip()
    if not raw:
        return None
    if raw.startswith('@'):
        return raw
    low = raw.lower()
    if 't.me/' in low:
        return '@' + raw.split('t.me/')[-1].strip('/').split('?')[0]
    try:
        return int(raw)
    except ValueError:
        return '@' + raw.lstrip('@')


def get_broadcast_chat_ids():
    ids = []
    seen = set()
    for item in parse_group_values(get_group_env_value()):
        cid = normalize_chat_id(item)
        if cid is None:
            continue
        key = str(cid)
        if key in seen:
            continue
        seen.add(key)
        ids.append(cid)
    return ids


def bot_api_json(method, payload, timeout=45):
    if not TOKEN_BOT:
        raise RuntimeError('TOKEN_BOT chua cau hinh')
    import urllib.request
    url = f'https://api.telegram.org/bot{TOKEN_BOT}/{method}'
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        url, data=data, headers={'Content-Type': 'application/json'}, method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        detail = ''
        try:
            detail = e.read().decode('utf-8')  # noqa
            body = json.loads(detail)
            raise RuntimeError(body.get('description') or detail) from e
        except RuntimeError:
            raise
        except Exception:
            raise RuntimeError(str(e) + ((' | ' + detail) if detail else '')) from e
    if not body.get('ok'):
        raise RuntimeError(body.get('description') or str(body))
    return body


def bot_api_send_photo(chat_id, filepath, caption='', parse_mode='HTML', timeout=90):
    if not TOKEN_BOT:
        raise RuntimeError('TOKEN_BOT chua cau hinh')
    import urllib.request
    boundary = '----TeleBotBoundary7MA4YWxkTrZu0gW'
    with open(filepath, 'rb') as f:
        file_bytes = f.read()
    filename = os.path.basename(filepath) or 'shot.jpg'
    ctype = 'image/jpeg' if filename.lower().endswith(('.jpg', '.jpeg')) else 'image/png'
    fields = {
        'chat_id': str(chat_id),
        'caption': caption or '',
        'parse_mode': parse_mode or 'HTML',
    }
    body = bytearray()
    for k, v in fields.items():
        body.extend(f'--{boundary}\r\n'.encode())
        body.extend(f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode())
        body.extend(str(v).encode('utf-8'))
        body.extend(b'\r\n')
    body.extend(f'--{boundary}\r\n'.encode())
    body.extend(
        f'Content-Disposition: form-data; name="photo"; filename="{filename}"\r\n'.encode()
    )
    body.extend(f'Content-Type: {ctype}\r\n\r\n'.encode())
    body.extend(file_bytes)
    body.extend(f'\r\n--{boundary}--\r\n'.encode())
    url = f'https://api.telegram.org/bot{TOKEN_BOT}/sendPhoto'
    req = urllib.request.Request(
        url,
        data=bytes(body),
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            out = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        detail = ''
        try:
            detail = e.read().decode('utf-8')  # noqa
            error_body = json.loads(detail)
            raise RuntimeError(error_body.get('description') or detail) from e
        except RuntimeError:
            raise
        except Exception:
            raise RuntimeError(str(e) + ((' | ' + detail) if detail else '')) from e
    if not out.get('ok'):
        raise RuntimeError(out.get('description') or str(out))
    return out


def bot_api_broadcast_text(text, parse_mode='HTML'):
    chat_ids = get_broadcast_chat_ids()
    if not chat_ids:
        raise RuntimeError('GROUP rong — them id nhom vao .env')
    def send_one(cid):
        try:
            bot_api_json(
                'sendMessage',
                {
                    'chat_id': cid,
                    'text': text,
                    'parse_mode': parse_mode,
                    'disable_web_page_preview': True,
                },
            )
            return cid, None
        except Exception as e:
            return cid, e

    ok, fail = 0, 0
    with ThreadPoolExecutor(max_workers=min(5, len(chat_ids))) as pool:
        futures = [pool.submit(send_one, cid) for cid in chat_ids]
        for future in as_completed(futures):
            cid, error = future.result()
            if error is None:
                ok += 1
                log(f'[BOT API] sendMessage OK → {cid}')
            else:
                fail += 1
                log(f'[BOT API] sendMessage FAIL → {cid}: {error}')
    if ok == 0:
        raise RuntimeError(f'Bot API khong gui duoc tin nao (fail={fail})')
    return ok, fail


def bot_api_broadcast_photo(filepath, caption='', parse_mode='HTML'):
    chat_ids = get_broadcast_chat_ids()
    if not chat_ids:
        raise RuntimeError('GROUP rong — them id nhom vao .env')
    def send_one(cid):
        try:
            bot_api_send_photo(cid, filepath, caption=caption, parse_mode=parse_mode)
            return cid, None
        except Exception as e:
            return cid, e

    ok, fail = 0, 0
    with ThreadPoolExecutor(max_workers=min(5, len(chat_ids))) as pool:
        futures = [pool.submit(send_one, cid) for cid in chat_ids]
        for future in as_completed(futures):
            cid, error = future.result()
            if error is None:
                ok += 1
                log(f'[BOT API] sendPhoto OK → {cid}')
            else:
                fail += 1
                log(f'[BOT API] sendPhoto FAIL → {cid}: {error}')
    if ok == 0:
        raise RuntimeError(f'Bot API khong gui duoc anh nao (fail={fail})')
    return ok, fail



def get_client():
    if client is None:
        raise RuntimeError('Telegram client chua duoc khoi tao')
    return client


def parse_group_values(group_value):
    raw_value = (group_value or '').strip()
    if not raw_value:
        return []

    group_values = []
    seen = set()
    for item in re.split(r'[\n,;]+', raw_value):
        candidate = item.strip()
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        group_values.append(candidate)
    return group_values


def build_group_candidates(group_value):
    raw_value = (group_value or '').strip()
    if not raw_value:
        return []

    candidates = [raw_value]
    try:
        numeric_value = int(raw_value)
    except ValueError:
        return candidates

    candidates.append(numeric_value)

    if numeric_value > 0:
        candidates.append(int(f'-100{numeric_value}'))
        candidates.append(-numeric_value)
    elif raw_value.startswith('-100'):
        candidates.append(int(raw_value[4:]))
    else:
        candidates.append(int(f'-100{abs(numeric_value)}'))

    unique_candidates = []
    seen = set()
    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        unique_candidates.append(candidate)
    return unique_candidates


async def resolve_group_entity(group_value):
    telegram_client = get_client()
    candidates = build_group_candidates(group_value)
    if not candidates:
        raise ValueError('GROUP chua duoc cau hinh trong .env')

    candidate_ids = {candidate for candidate in candidates if isinstance(candidate, int)}
    normalized_usernames = {
        candidate.lower().lstrip('@').replace('https://t.me/', '').replace('http://t.me/', '').rstrip('/')
        for candidate in candidates
        if isinstance(candidate, str) and not candidate.lstrip('-').isdigit()
    }

    async def _follow_migration(entity):
        """Nhóm cũ migrate lên supergroup → luôn dùng entity mới."""
        if not entity:
            return entity
        migrated = getattr(entity, 'migrated_to', None)
        if not migrated:
            return entity
        try:
            new_entity = await telegram_client.get_entity(migrated)
            log(
                f"[GROUP] Chat đã migrate → id={getattr(new_entity, 'id', None)} "
                f"title={getattr(new_entity, 'title', None)}"
            )
            return new_entity
        except Exception as e:
            log(f"[GROUP WARN] Không resolve migrated_to: {e}")
            return entity

    # 1. Duyệt dialogs đã tham gia
    async for dialog in telegram_client.iter_dialogs():
        entity_id = getattr(dialog.entity, 'id', None)
        dialog_ids = {dialog.id}
        if entity_id:
            dialog_ids.add(entity_id)
            dialog_ids.add(-entity_id)
            try:
                dialog_ids.add(int(f'-100{entity_id}'))
            except Exception:
                pass

        username = (getattr(dialog.entity, 'username', None) or '').lower()
        if candidate_ids.intersection(dialog_ids):
            return await _follow_migration(dialog.entity)
        if username and username in normalized_usernames:
            return await _follow_migration(dialog.entity)

    # 2. Fallback get_entity
    last_error = None
    for candidate in candidates:
        try:
            entity = await telegram_client.get_entity(candidate)
            return await _follow_migration(entity)
        except Exception as exc:
            last_error = exc

    raise RuntimeError(
        f'Khong tim thay entity cho GROUP={group_value}. '
        f'Hay dung @username hoac ID -100..., va dam bao account da join nhom. '
        f'Loi goc: {last_error}'
    )


async def resolve_group_entities(group_value):
    group_values = parse_group_values(group_value)
    if not group_values:
        raise ValueError('GROUP chua duoc cau hinh trong .env')

    entities = []
    seen_ids = set()
    for value in group_values:
        entity = await resolve_group_entity(value)
        entity_id = getattr(entity, 'id', None)
        dedupe_key = entity_id if entity_id is not None else value
        if dedupe_key in seen_ids:
            continue
        seen_ids.add(dedupe_key)
        entities.append(entity)
    return entities


async def login_client():
    if not phone:
        log('[ERROR] PHONE chua cau hinh trong .env')
        sys.exit(1)
    telegram_client = get_client()
    if not telegram_client.is_connected():
        log('[INFO] Dang mo ket noi toi Telegram...')
        await asyncio.wait_for(telegram_client.connect(), timeout=30)
        log('[INFO] Da mo ket noi toi Telegram')
    else:
        log('[INFO] Telegram client da connected san')

    log('[INFO] Dang kiem tra trang thai dang nhap...')
    if await asyncio.wait_for(telegram_client.is_user_authorized(), timeout=30):
        log('[INFO] Session da dang nhap san, bo qua buoc OTP')
        return
    log('[INFO] Session chua dang nhap, se gui ma OTP')

    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        log(f'[INFO] Dang gui yeu cau OTP lan {attempt}/{max_attempts}...')
        sent_code = await asyncio.wait_for(telegram_client.send_code_request(phone), timeout=60)
        log('[INFO] Da gui OTP. Kiem tra Telegram/SMS va nhap ma moi nhat.')
        code = input('Please enter the code you received: ').strip()

        try:
            await telegram_client.sign_in(
                phone=phone,
                code=code,
                phone_code_hash=sent_code.phone_code_hash,
            )
            return
        except SessionPasswordNeededError:
            log('[INFO] Tai khoan da bat 2FA, can nhap mat khau xac minh 2 buoc.')
            password_attempts = [twofa_password] if twofa_password else []
            max_password_attempts = 3

            for password_attempt in range(1, max_password_attempts + 1):
                if password_attempt > len(password_attempts):
                    password_attempts.append(
                        input('Please enter your 2FA password: ').strip()
                    )

                password = password_attempts[password_attempt - 1]
                try:
                    await telegram_client.sign_in(password=password)
                    return
                except PasswordHashInvalidError:
                    log(
                        f'[WARN] Mat khau 2FA khong dung '
                        f'({password_attempt}/{max_password_attempts}).'
                    )

            raise RuntimeError(
                'Mat khau 2FA khong hop le sau nhieu lan thu. '
                'Hay kiem tra lai mat khau Telegram hoac cau hinh '
                'TELEGRAM_2FA_PASSWORD trong .env.'
            )
        except PhoneCodeExpiredError:
            log(f'[WARN] Ma OTP da het han. Dang xin ma moi ({attempt}/{max_attempts})...')
        except (PhoneCodeInvalidError, PhoneCodeEmptyError):
            log(f'[WARN] Ma OTP khong hop le. Hay nhap dung ma moi nhat ({attempt}/{max_attempts})...')
        except asyncio.TimeoutError:
            log(f'[WARN] Telegram phan hoi qua lau khi gui/kiem tra OTP ({attempt}/{max_attempts})...')

    raise RuntimeError('Dang nhap that bai sau nhieu lan thu OTP. Hay chay lai bot va nhap ma moi nhat ngay khi nhan duoc.')

def ensure_directories():
    """Create necessary directories if they don't exist"""
    directories = [
        FIXED_IMAGES_DIR,
        WINCAI_IMAGES_DIR,
        LOSECAI_IMAGES_DIR,
        WINCON_IMAGES_DIR,
        LOSECON_IMAGES_DIR,
        TIE_IMAGES_DIR
    ]
    for directory in directories:
        os.makedirs(directory, exist_ok=True)

def load_posts():
    """Load posts from JSON file"""
    if os.path.exists(POSTS_FILE):
        with open(POSTS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {
        'fixed_posts': {},  # Key: time (HH:MM), Value: list of posts
        'rotating_posts': {
            'wincai': {},  # Key: time (HH:MM), Value: list of posts
            'losecai': {},  # Key: time (HH:MM), Value: list of posts
            'wincon': {},  # Key: time (HH:MM), Value: list of posts
            'losecon': {},  # Key: time (HH:MM), Value: list of posts
            'tie': {}      # Key: time (HH:MM), Value: list of posts
        }
    }

def save_posts(posts):
    """Save posts to JSON file"""
    with open(POSTS_FILE, 'w', encoding='utf-8') as f:
        json.dump(posts, f, ensure_ascii=False, indent=4)

def get_next_rotating_post_index(time_slot, result_type):
    """Get the index of the next rotating post to send for a specific time slot and result type"""
    posts = load_posts()
    if not posts['rotating_posts'][result_type].get(time_slot):
        return 0
    
    rotating_posts = posts['rotating_posts'][result_type][time_slot]
    if not rotating_posts:
        return 0
    
    # Get the last sent post index
    last_index = rotating_posts[-1].get('last_sent_index', -1)
    next_index = (last_index + 1) % len(rotating_posts)
    
    # Update the last sent index
    rotating_posts[-1]['last_sent_index'] = next_index
    posts['rotating_posts'][result_type][time_slot] = rotating_posts
    save_posts(posts)
    
    return next_index

def detect_bet_side(text):
    text_upper = (text or '').upper()
    if 'CÁI' in text_upper or 'CAI' in text_upper or 'NHÀ CÁI' in text_upper:
        return 'cai'
    if 'CON' in text_upper or 'NHÀ CON' in text_upper:
        return 'con'
    return 'con'

def list_images_in_dir(dir_path):
    if not os.path.exists(dir_path):
        return []
    files = []
    for name in sorted(os.listdir(dir_path)):
        if name.startswith('.'):
            continue
        if os.path.splitext(name)[1].lower() in IMAGE_EXTENSIONS:
            files.append(os.path.join(dir_path, name))
    return files

def get_result_image_path(result_type):
    """Lấy ảnh kết quả từ posts.json, fallback chọn ngẫu nhiên từ thư mục images/."""
    posts = load_posts()
    rotating_posts = posts['rotating_posts'][result_type].get(RESULT_TIME_SLOT, [])
    if rotating_posts:
        next_index = get_next_rotating_post_index(RESULT_TIME_SLOT, result_type)
        path = rotating_posts[next_index]['image_path']
        if os.path.exists(path):
            return path
        print(f"[WARN] Ảnh trong posts.json không tồn tại: {path}")

    images = list_images_in_dir(RESULT_IMAGE_DIRS[result_type])
    if images:
        return random.choice(images)
    return None

import urllib.request
import urllib.parse

API_BASE_URL = os.getenv('API_BASE_URL', 'http://localhost:3201').rstrip('/')
API_KEY = (os.getenv('API_KEY') or 'your-static-api-key').strip('"\'')


def _api_headers(json_body=False):
    headers = {
        'User-Agent': 'Mozilla/5.0',
        'x-api-key': API_KEY,
    }
    if json_body:
        headers['Content-Type'] = 'application/json'
    return headers


def api_get_json(path, timeout=10):
    url = f"{API_BASE_URL}{path}" if path.startswith('/') else path
    req = urllib.request.Request(url, headers=_api_headers(), method='GET')
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode('utf-8'))


def api_post_json(path, body, timeout=15):
    url = f"{API_BASE_URL}{path}" if path.startswith('/') else path
    payload = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(
        url, data=payload, headers=_api_headers(json_body=True), method='POST'
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode('utf-8'))


def set_target_table_api(table_name):
    """Thông báo cho Playwright Server chuyển sang bàn cược target"""
    try:
        res_data = api_post_json('/api/set-target-table', {"tableName": table_name}, timeout=5)
        print(f"[API TARGET TABLE] Đã phát tín hiệu báo bàn Playwright: {table_name} -> {res_data}")
        return res_data
    except Exception as e:
        print(f"[API TARGET TABLE ERROR] Không thể kết nối Playwright Server: {e}")
        return None


def request_change_table_api(table_name=None, reason='cầu xấu'):
    """Yêu cầu session out bàn xấu → chọn bàn cầu đẹp khác."""
    try:
        body = {
            'nameService': get_name_service(),
            'reason': reason or 'cầu xấu',
        }
        if table_name:
            body['tableName'] = str(table_name).strip().upper()
        res_data = api_post_json('/api/request-change-table', body, timeout=5)
        print(
            f"[API ĐỔI BÀN] {body.get('tableName') or '?'} — {reason} -> {res_data}",
            flush=True,
        )
        return res_data
    except Exception as e:
        print(f"[API ĐỔI BÀN ERROR] {e}", flush=True)
        return None


async def get_real_screenshot_data_async(
    table_name=None,
    min_stamp_time=None,
    max_wait_seconds=15,
    poll_s=0.35,
    expect_winner=None,
):
    """Chỉ lấy ảnh THẬT từ Playwright (sexy_*). Nếu expect_winner: bắt buộc khớp resultWinner (B/P/T)."""
    url = f"{API_BASE_URL}/api/latest-screenshot"
    if table_name:
        url += f"?tableName={urllib.parse.quote(str(table_name))}"

    start_wait = time.time()
    expect = road_to_side(expect_winner) if expect_winner else None

    while True:
        try:
            req = urllib.request.Request(url, headers=_api_headers())
            with urllib.request.urlopen(req, timeout=2) as response:
                res_data = json.loads(response.read().decode('utf-8'))
                if res_data.get('success') and res_data.get('data'):
                    data = res_data['data']
                    filepath = data.get('filepath')
                    stamp_time = data.get('stampTime', 0)
                    shot_winner = road_to_side(data.get('resultWinner'))
                    if is_real_screenshot_path(filepath):
                        try:
                            stamp_n = int(stamp_time or 0)
                        except (TypeError, ValueError):
                            stamp_n = 0
                        min_n = None
                        try:
                            min_n = int(min_stamp_time) if min_stamp_time is not None else None
                        except (TypeError, ValueError):
                            min_n = None
                        if min_n is not None and stamp_n < min_n:
                            print(
                                f"[API REAL SCREENSHOT] ảnh cũ stamp={stamp_n} < min={min_n} — chờ...",
                                flush=True,
                            )
                        elif expect and shot_winner != expect:
                            # FORCE không có resultWinner / ảnh lệch ván → bỏ, chờ ảnh new_round
                            print(
                                f"[API REAL SCREENSHOT] bỏ ảnh winner={shot_winner} "
                                f"(cần {expect}) round={data.get('roundNum')} — chờ khớp API...",
                                flush=True,
                            )
                        else:
                            print(
                                f"[API REAL SCREENSHOT] OK stamp={stamp_n} winner={shot_winner} "
                                f"round={data.get('roundNum')} file={filepath}",
                                flush=True,
                            )
                            return data
        except Exception as e:
            print(f"[API REAL SCREENSHOT ERROR] {table_name}: {e}", flush=True)

        if time.time() - start_wait >= max_wait_seconds:
            break
        await asyncio.sleep(poll_s)

    print(
        f"[API REAL SCREENSHOT] TIMEOUT {max_wait_seconds}s expect={expect} — KHÔNG dùng ảnh ảo",
        flush=True,
    )
    return None


def is_real_screenshot_path(filepath):
    """Chỉ nhận ảnh capture thật, từ chối images/win*|lose*|photo_* mock."""
    if not filepath or not os.path.exists(filepath):
        return False
    norm = str(filepath).replace("\\", "/").lower()
    name = os.path.basename(norm)
    if "/images/" in norm and "/screenshots/" not in norm:
        return False
    if name.startswith("photo_"):
        return False
    return ("/screenshots/" in norm) or name.startswith("sexy_")


def get_real_screenshot_path(table_name=None):
    try:
        url = f"{API_BASE_URL}/api/latest-screenshot"
        if table_name:
            url += f"?tableName={urllib.parse.quote(str(table_name))}"
        req = urllib.request.Request(url, headers=_api_headers())
        with urllib.request.urlopen(req, timeout=3) as response:
            res_data = json.loads(response.read().decode('utf-8'))
            if res_data.get('success') and res_data.get('data'):
                filepath = res_data['data'].get('filepath')
                if is_real_screenshot_path(filepath):
                    return filepath
    except Exception:
        pass
    return None


def get_active_table_api():
    """Chỉ trả bàn khi Playwright ĐÃ VÀO BÀN và notify (có readyAt)."""
    try:
        ns = get_name_service()
        path = f'/api/get-active-table?nameService={urllib.parse.quote(ns)}'
        res_data = api_get_json(path, timeout=5)
        if res_data.get('paused'):
            now = time.time()
            last_log = globals().get('_last_pause_log_at', 0)
            if now - last_log >= 10:
                globals()['_last_pause_log_at'] = now
                print(
                    "[WAIT BÀN] Hệ thống đang phân tích cầu kèo — chờ session restart",
                    flush=True,
                )
            globals()['_system_paused'] = True
            return None
        globals()['_system_paused'] = False
        if res_data.get('success') and res_data.get('activeTable'):
            table = str(res_data['activeTable']).upper().strip()
            if table and table not in ('NONE', 'LOBBY'):
                ready_at = res_data.get('readyAt')
                # Không có readyAt (server cũ) vẫn chấp nhận
                return {'table': table, 'readyAt': ready_at}
        else:
            now = time.time()
            last_log = globals().get('_last_wait_ban_log_at', 0)
            if now - last_log >= 10:
                globals()['_last_wait_ban_log_at'] = now
                print(
                    f"[WAIT BÀN] Playwright chưa vào bàn: "
                    f"{res_data.get('message') or res_data}",
                    flush=True,
                )
    except Exception as e:
        print(f"[API ACTIVE TABLE ERROR] {e}", flush=True)
    return None


def get_table_by_name_api(table_name):
    """Cùng API FE: GET /predict/get-table-by-name"""
    try:
        q = urllib.parse.quote(str(table_name or '').strip())
        raw = api_get_json(f'/predict/get-table-by-name?tableName={q}', timeout=10)
        if isinstance(raw, dict) and isinstance(raw.get('totalRound'), list):
            return raw
        if isinstance(raw, dict) and isinstance(raw.get('data'), dict):
            return raw['data']
        return raw if isinstance(raw, dict) else {}
    except Exception as e:
        print(f"[API GET-TABLE ERROR] {e}", flush=True)
        return {}


def _norm_bp_side(raw):
    if raw is None:
        return None
    u = str(raw).strip().upper()
    if u in ('B', 'BANKER', 'CAI', 'CÁI') or u.startswith('B'):
        return 'B'
    if u in ('P', 'PLAYER', 'CON') or u.startswith('P'):
        return 'P'
    return None


def road_to_side(road_or_format):
    if road_or_format in ('B', 'P', 'T'):
        return road_or_format
    if isinstance(road_or_format, str):
        u = road_or_format.strip().upper()
        if u in ('B', 'BANKER'):
            return 'B'
        if u in ('P', 'PLAYER'):
            return 'P'
        if u in ('T', 'TIE', 'HÒA', 'HOA'):
            return 'T'
    try:
        code = int(road_or_format)
    except (TypeError, ValueError):
        return None
    if code in (0, 1, 2):
        return 'B'
    if code in (8, 9, 10):
        return 'P'
    return 'T'


def extract_bp_sequence(payload, limit=48):
    """Chuỗi B/P theo thời gian tăng (bỏ Hòa) từ totalRound."""
    rounds = payload.get('totalRound') if isinstance(payload, dict) else None
    if not isinstance(rounds, list) or not rounds:
        return []
    ordered = []
    for r in rounds:
        if not isinstance(r, dict):
            continue
        try:
            st = int(r.get('stampTime')) if r.get('stampTime') is not None else None
        except (TypeError, ValueError):
            st = None
        side = road_to_side(r.get('roadFormat') or r.get('road'))
        if side not in ('B', 'P') or st is None:
            continue
        ordered.append((st, side))
    ordered.sort(key=lambda x: x[0])
    seq = [side for _, side in ordered]
    if limit and len(seq) > limit:
        return seq[-limit:]
    return seq


def _current_streak(seq):
    if not seq:
        return None, 0
    last = seq[-1]
    n = 1
    for i in range(len(seq) - 2, -1, -1):
        if seq[i] == last:
            n += 1
        else:
            break
    return last, n


def _is_chop(seq, lookback=6):
    if len(seq) < 4:
        return False
    window = seq[-lookback:] if len(seq) >= lookback else seq
    if len(window) < 4:
        return False
    flips = sum(1 for i in range(1, len(window)) if window[i] != window[i - 1])
    return flips >= len(window) - 1


def _is_two_two(seq):
    if len(seq) < 6:
        return False
    tail = seq[-6:]
    return (
        tail[0] == tail[1]
        and tail[2] == tail[3]
        and tail[4] == tail[5]
        and tail[0] != tail[2]
        and tail[2] != tail[4]
        and tail[0] == tail[4]
    )


def _run_length_pattern(seq):
    """
    Đọc nhịp cầu theo độ dài các dây liên tiếp, ví dụ 1-3-1-2.
    Tìm nhịp cuối đã từng xuất hiện trong chính 20 tay rồi suy ra dây hiện tại
    nên tiếp tục hay đổi cửa.
    """
    if len(seq) < 8:
        return None
    runs = []
    for side in seq:
        if runs and runs[-1]['side'] == side:
            runs[-1]['length'] += 1
        else:
            runs.append({'side': side, 'length': 1})
    if len(runs) < 5:
        return None

    completed = runs[:-1]
    lengths = [r['length'] for r in completed]
    current = runs[-1]
    max_context = min(5, len(lengths) - 1)
    for context_size in range(max_context, 1, -1):
        needle = lengths[-context_size:]
        targets = []
        for i in range(0, len(lengths) - context_size):
            if lengths[i:i + context_size] == needle:
                target = lengths[i + context_size]
                if 1 <= target <= 8:
                    targets.append(target)
        if not targets or len(set(targets)) != 1:
            continue
        target_length = targets[0]
        if current['length'] > target_length:
            continue
        side = (
            current['side']
            if current['length'] < target_length
            else ('P' if current['side'] == 'B' else 'B')
        )
        confidence = min(
            0.90,
            0.72 + context_size * 0.015 + min(len(targets), 3) * 0.02,
        )
        expanded = lengths + [target_length]
        rhythm = needle + [target_length]
        for period in range(2, min(6, len(expanded) // 2) + 1):
            if expanded[-period:] == expanded[-2 * period:-period]:
                rhythm = expanded[-period:]
                break
        return {
            'side': side,
            'confidence': round(confidence, 3),
            'rhythm': rhythm,
            'target_length': target_length,
            'current_length': current['length'],
            'matches': len(targets),
        }
    return None


def _pattern_next(seq, size):
    if len(seq) < size * 2:
        return None
    block = tuple(seq[-size:])
    prev = tuple(seq[-size * 2 : -size])
    if block != prev:
        return None
    # Pattern lặp block → tay kế theo block[0] của chu kỳ (cùng vị trí)
    return block[0]


def _ngram_next(seq, n):
    """Tìm n-gram gần nhất trong lịch sử rồi lấy ký tự kế tiếp."""
    if len(seq) < n + 2:
        return None
    needle = tuple(seq[-n:])
    votes = {'B': 0, 'P': 0}
    for i in range(len(seq) - n - 1):
        if tuple(seq[i : i + n]) == needle:
            nxt = seq[i + n]
            if nxt in votes:
                votes[nxt] += 1
    if votes['B'] == votes['P'] == 0:
        return None
    if votes['B'] == votes['P']:
        return None
    return 'B' if votes['B'] > votes['P'] else 'P'


def _ai_side_from_payload(payload, key):
    block = payload.get(key) if isinstance(payload, dict) else None
    if not isinstance(block, dict):
        return None, 0.0
    pc = block.get('percentCurrent') or {}
    if not isinstance(pc, dict):
        return None, 0.0
    side = _norm_bp_side(pc.get('Round') or pc.get('round'))
    try:
        forecast = float(pc.get('Forecast') or 0)
    except (TypeError, ValueError):
        forecast = 0.0
    banker = float(pc.get('Banker') or 0)
    player = float(pc.get('Player') or 0)
    margin = abs(banker - player)
    conf = max(forecast, 50.0 + margin / 2.0) / 100.0
    return side, conf


def decide_road_signal(payload):
    """
    Thuật toán cầu ensemble cho hô + đặt:
      1) Bệt (streak) ≥2 → theo cầu
      2) Cầu 1-1 (chop) → đảo chiều
      3) Cầu 2-2 → tiếp tục block
      4) Pattern / n-gram lịch sử
      5) Bias cửa sổ gần
      6) Vote AI1–AI4 hỗ trợ
    Trả về dict: side B|P, confidence 0..1, reason, unstable.
    percentCurrent.Round gốc là random — KHÔNG dùng làm tín hiệu chính.
    """
    seq = extract_bp_sequence(payload)
    if len(seq) < 4:
        return {
            'side': None,
            'confidence': 0.0,
            'reason': 'thiếu cầu',
            'unstable': True,
            'seq_tail': ''.join(seq[-12:]),
        }

    scores = {'B': 0.0, 'P': 0.0}
    reasons = []

    last, streak = _current_streak(seq)
    recent = seq[-8:] if len(seq) >= 8 else seq
    recent_flips = sum(
        1 for i in range(1, len(recent)) if recent[i] != recent[i - 1]
    )
    recent_chop = recent_flips / max(1, len(recent) - 1)

    # Cầu gần đang 1-1 / lộn → ưu tiên đảo, không bám bias xa
    if recent_chop >= 0.7 and max(streak, 0) <= 2:
        opp = 'P' if seq[-1] == 'B' else 'B'
        scores[opp] += 2.0
        reasons.append(f'recent_chop→{opp}+2.0')
    elif last and streak >= 2:
        # Chỉ theo bệt khi dây còn đang chạy; không cộng bias xa
        w = 2.4 if streak >= 5 else (2.0 if streak >= 4 else (1.6 if streak == 3 else 1.1))
        scores[last] += w
        reasons.append(f'bệt{streak}{last}+{w:.1f}')

    if _is_chop(seq):
        opp = 'P' if seq[-1] == 'B' else 'B'
        scores[opp] += 1.4
        reasons.append(f'chop→{opp}+1.4')

    if _is_two_two(seq):
        # Sau BB PP BB → tiếp P (mở block mới đối lập)
        nxt = 'P' if seq[-1] == 'B' else 'B'
        scores[nxt] += 1.8
        reasons.append(f'2-2→{nxt}+1.8')

    rhythm = _run_length_pattern(seq)
    if rhythm and rhythm.get('side') in ('B', 'P'):
        rhythm_side = rhythm['side']
        scores[rhythm_side] += 2.2
        rhythm_name = '-'.join(str(x) for x in rhythm['rhythm'])
        reasons.append(f'nhịp{rhythm_name}→{rhythm_side}+2.2')

    for size in (2, 3, 4):
        nxt = _pattern_next(seq, size)
        if nxt in ('B', 'P'):
            scores[nxt] += 1.2
            reasons.append(f'repeat{size}→{nxt}+1.2')
            break

    for n in (3, 4, 5):
        nxt = _ngram_next(seq, n)
        if nxt in ('B', 'P'):
            scores[nxt] += 1.1 + (n - 3) * 0.15
            reasons.append(f'ngram{n}→{nxt}')
            break

    # Bias chỉ hỗ trợ nhẹ và phải khớp 2 tay gần nhất — tránh spam cùng 1 cửa
    window = seq[-12:] if len(seq) >= 12 else seq
    b_cnt = window.count('B')
    p_cnt = window.count('P')
    if b_cnt != p_cnt and len(seq) >= 2 and seq[-1] == seq[-2]:
        bias = 'B' if b_cnt > p_cnt else 'P'
        if bias == seq[-1]:
            scores[bias] += 0.35
            reasons.append(f'bias_confirm→{bias}({b_cnt}/{p_cnt})')

    # AI calculators (bỏ ai0 = percentCurrent random)
    for key, weight in (('ai1', 0.7), ('ai2', 0.6), ('ai3', 0.5), ('ai4', 0.5)):
        side, conf = _ai_side_from_payload(payload, key)
        if side in ('B', 'P'):
            scores[side] += weight * max(0.4, min(1.0, conf))
            reasons.append(f'{key}→{side}')

    # percentCurrent chỉ tie-break — trước đây +2.8 khiến hô spam cùng cửa
    pc = payload.get('percentCurrent') if isinstance(payload, dict) else None
    if isinstance(pc, dict):
        rnd = _norm_bp_side(pc.get('Round') or pc.get('round'))
        if rnd in ('B', 'P') and abs(scores['B'] - scores['P']) < 0.45:
            scores[rnd] += 0.2
            reasons.append(f'pc_tiebreak→{rnd}')

    if scores['B'] == scores['P'] == 0:
        return {
            'side': None,
            'confidence': 0.0,
            'reason': 'không có tín hiệu',
            'unstable': True,
            'seq_tail': ''.join(seq[-12:]),
        }

    if scores['B'] == scores['P']:
        side = seq[-1]  # giữ quán tính khi hòa điểm
        confidence = 0.45
        unstable = True
        reasons.append('hòa điểm→theo tay cuối')
    else:
        side = 'B' if scores['B'] > scores['P'] else 'P'
        total = scores['B'] + scores['P']
        margin = abs(scores['B'] - scores['P'])
        confidence = min(0.96, 0.48 + margin / max(total, 1.0) * 0.55)
        unstable = confidence < 0.62 or margin < 1.0

    return {
        'side': side,
        'confidence': round(confidence, 3),
        'reason': ', '.join(reasons[:6]) or 'ensemble',
        'unstable': unstable,
        'scores': {'B': round(scores['B'], 2), 'P': round(scores['P'], 2)},
        'seq_tail': ''.join(seq[-12:]),
        'streak': streak,
    }


def _max_streak_in_seq(seq):
    if not seq:
        return None, 0
    best_side, best_len = seq[0], 1
    cur_side, cur_len = seq[0], 1
    for i in range(1, len(seq)):
        if seq[i] == seq[i - 1]:
            cur_len += 1
        else:
            cur_side, cur_len = seq[i], 1
        if cur_len > best_len:
            best_side, best_len = cur_side, cur_len
    return best_side, best_len


def analyze_road_profile(payload, window=None):
    """
    Phân tích cầu thực tế trên N tay B/P gần nhất (mặc định 20).
    Trả về loại cầu, xu hướng, cửa đề xuất và có được phép hô hay không.
    """
    win = int(window or ROAD_ANALYSIS_WINDOW)
    seq_all = extract_bp_sequence(payload, limit=max(win, 48))
    seq = seq_all[-win:] if len(seq_all) >= win else seq_all
    hand_count = len(seq)

    base = {
        'ready': False,
        'road_type': 'WAIT',
        'side': None,
        'confidence': 0.0,
        'trend': '',
        'hand_count': hand_count,
        'window': win,
        'seq_display': ''.join(seq),
        'b_count': seq.count('B'),
        'p_count': seq.count('P'),
        'streak': 0,
        'streak_side': None,
        'max_streak': 0,
        'max_streak_side': None,
        'chop_ratio': 0.0,
        'reason': '',
    }

    if hand_count < ROAD_ANALYSIS_MIN_BP:
        base['road_type'] = 'WAIT'
        base['reason'] = f'thiếu cầu ({hand_count}/{ROAD_ANALYSIS_MIN_BP} tay B/P)'
        base['trend'] = 'chưa đủ dữ liệu phân tích'
        return base

    last, streak = _current_streak(seq)
    max_side, max_streak = _max_streak_in_seq(seq)
    rhythm = _run_length_pattern(seq)
    lookback = seq[-18:] if len(seq) >= 18 else seq
    flips = sum(1 for i in range(1, len(lookback)) if lookback[i] != lookback[i - 1])
    chop_ratio = flips / max(1, len(lookback) - 1)
    recent = seq[-8:] if len(seq) >= 8 else seq
    recent_flips = sum(
        1 for i in range(1, len(recent)) if recent[i] != recent[i - 1]
    )
    recent_chop = recent_flips / max(1, len(recent) - 1)
    b_cnt, p_cnt = base['b_count'], base['p_count']
    bias_ratio = max(b_cnt, p_cnt) / max(1, hand_count)
    bias_side = 'B' if b_cnt > p_cnt else ('P' if p_cnt > b_cnt else None)
    bias_confirmed = (
        bias_side in ('B', 'P')
        and len(seq) >= 2
        and seq[-1] == bias_side
        and seq[-2] == bias_side
    )
    # Bệt dài vừa gãy → không nhảy sang hô cửa lệch cũ
    streak_broken = (
        max_streak >= 4
        and streak <= 2
        and last in ('B', 'P')
        and max_side in ('B', 'P')
        and last != max_side
    )

    road_type = 'NOISE'
    side = None
    confidence = 0.0
    trend = 'cầu lộn xộn'

    if recent_chop >= 0.72 and streak <= 2:
        road_type = 'CHOP'
        side = 'P' if last == 'B' else 'B'
        confidence = 0.50 + min(0.15, (recent_chop - 0.72) * 2.0)
        trend = f'cầu gần đảo ({recent_flips}/{max(1, len(recent) - 1)}) — không spam'
    elif streak_broken:
        road_type = 'BREAK'
        side = None
        confidence = 0.40
        trend = (
            f'bệt {max_side}x{max_streak} vừa gãy → '
            f'{"Cái" if last == "B" else "Con"} — chờ cầu mới'
        )
    elif chop_ratio >= 0.78 and max_streak <= 3:
        road_type = 'CHOP'
        side = 'P' if last == 'B' else 'B'
        confidence = 0.52 + min(0.18, (chop_ratio - 0.78) * 2.5)
        trend = f'cầu 1-1 đảo ({flips}/{len(lookback) - 1} lần lật)'
    elif rhythm and rhythm.get('side') in ('B', 'P'):
        road_type = 'RHYTHM'
        side = rhythm['side']
        confidence = float(rhythm['confidence'])
        rhythm_name = '-'.join(str(x) for x in rhythm['rhythm'])
        trend = (
            f'nhịp {rhythm_name}; dây hiện tại '
            f'{rhythm["current_length"]}/{rhythm["target_length"]}'
        )
    elif streak >= 3 and last in ('B', 'P'):
        road_type = 'BET'
        side = last
        # Bệt quá dài (>7) dễ gãy — không hô tiếp, đổi bàn
        confidence = 0.68 + min(0.18, (streak - 3) * 0.05)
        if streak >= 8:
            confidence = 0.55
            road_type = 'BREAK'
            side = None
            trend = f'bệt dài {"Cái" if last == "B" else "Con"} x{streak} — dừng hô, đổi bàn'
        else:
            trend = f'bệt {"Cái" if last == "B" else "Con"} x{streak}'
    elif _is_two_two(seq):
        road_type = 'TWO_TWO'
        side = 'P' if last == 'B' else 'B'
        confidence = 0.72
        trend = 'cầu 2-2 (BB PP lặp)'
    elif streak == 2 and last in ('B', 'P'):
        road_type = 'BET'
        side = last
        confidence = 0.66
        trend = f'bệt nhẹ {"Cái" if side == "B" else "Con"} x2'
    elif bias_ratio >= 0.62 and bias_confirmed:
        road_type = 'BIAS'
        side = bias_side
        confidence = 0.60 + min(0.12, abs(b_cnt - p_cnt) / hand_count * 0.5)
        trend = f'lệch xác nhận {"Cái" if side == "B" else "Con"} {b_cnt}/{p_cnt}'
    else:
        signal = decide_road_signal(payload)
        sig_side = signal.get('side')
        sig_conf = float(signal.get('confidence') or 0)
        if (
            sig_side in ('B', 'P')
            and sig_conf >= 0.68
            and not signal.get('unstable')
            and recent_chop < 0.65
        ):
            road_type = 'PATTERN'
            side = sig_side
            confidence = sig_conf
            trend = signal.get('reason') or 'pattern ensemble'
        else:
            road_type = 'NOISE'
            confidence = max(0.35, sig_conf * 0.85 if sig_conf else 0.35)
            if bias_ratio >= 0.58 and not bias_confirmed:
                trend = 'lệch cũ nhưng gần không khớp — không hô spam'
            else:
                trend = 'cầu chưa rõ — không vào kèo'

    signal = decide_road_signal(payload)
    if side in ('B', 'P') and signal.get('side') == side:
        confidence = min(0.96, confidence + 0.05)
    elif side in ('B', 'P') and signal.get('side') in ('B', 'P') and signal.get('side') != side:
        confidence = max(0.0, confidence - 0.15)

    # BIAS chỉ hô khi conf đủ cao; BREAK/CHOP/NOISE không hô
    bettable = (
        road_type in ('BET', 'RHYTHM', 'TWO_TWO', 'PATTERN')
        and confidence >= ROAD_ANALYSIS_MIN_CONF
    )
    if road_type == 'BIAS' and confidence >= max(ROAD_ANALYSIS_MIN_CONF, 0.78):
        bettable = True
    reason = trend
    if road_type == 'CHOP':
        reason = 'cầu chop — bỏ bàn, chờ cầu khác'
    elif road_type == 'BREAK':
        reason = 'bệt vừa gãy — chờ cầu mới, không spam cửa cũ'
    elif road_type == 'NOISE':
        reason = 'cầu lộn xộn — chưa đủ xu hướng'
    elif road_type == 'BIAS' and not bettable:
        reason = 'lệch nhẹ — chưa đủ chuẩn hô'

    base.update({
        'ready': bettable,
        'road_type': road_type,
        'side': side,
        'confidence': round(confidence, 3),
        'trend': trend,
        'streak': streak,
        'streak_side': last,
        'max_streak': max_streak,
        'max_streak_side': max_side,
        'chop_ratio': round(chop_ratio, 3),
        'reason': reason,
        'signal': signal,
    })
    return base


def format_road_analysis_message(table_name, profile):
    """Tin Telegram sau khi phân tích cầu 20 tay."""
    if not isinstance(profile, dict):
        return None
    side = profile.get('side')
    side_label = 'CÁI' if side == 'B' else ('CON' if side == 'P' else '—')
    type_labels = {
        'BET': 'BỆT',
        'CHOP': 'CHOP 1-1',
        'TWO_TWO': 'CẦU 2-2',
        'BIAS': 'LỆCH CỬA',
        'RHYTHM': 'NHỊP',
        'PATTERN': 'PATTERN',
        'BREAK': 'GÃY BỆT',
        'NOISE': 'LỘN XỘN',
        'WAIT': 'CHỜ DỮ LIỆU',
    }
    road_label = type_labels.get(profile.get('road_type'), profile.get('road_type') or '?')
    seq = profile.get('seq_display') or ''
    hands = profile.get('hand_count') or 0
    conf = float(profile.get('confidence') or 0) * 100

    if profile.get('ready'):
        action = f'✅ <b>SẴN SÀNG HÔ</b> — xu hướng <b>{side_label}</b> ({conf:.0f}%)'
    elif profile.get('road_type') == 'WAIT':
        action = '⏳ <b>ĐANG PHÂN TÍCH CẦU</b> — chưa đủ 20 tay B/P'
    elif profile.get('road_type') == 'CHOP':
        action = '⚠️ <b>CẦU CHOP</b> — không hô, chờ bàn/cầu khác'
    else:
        action = '⚠️ <b>CẦU CHƯA ỔN</b> — chờ cầu rõ hơn rồi mới hô'

    return (
        f'🔮 <b>PHÂN TÍCH CẦU {table_name}</b>\n'
        f'📊 {hands} tay: <code>{seq or "—"}</code>\n'
        f'📈 Loại: <b>{road_label}</b> | {profile.get("trend") or "—"}\n'
        f'🎯 Cái/Con: {profile.get("b_count") or 0}/{profile.get("p_count") or 0} '
        f'| Bệt max: {profile.get("max_streak") or 0}\n'
        f'{action}\n'
        f'{TELE_LINE}'
    )


def read_round_side(payload):
    """Tín hiệu hô/đặt: ưu tiên road percentCurrent server, ensemble xác nhận."""
    if not isinstance(payload, dict):
        return None
    pc = payload.get('percentCurrent') or {}
    pc_side = None
    pc_forecast = 0.0
    if isinstance(pc, dict):
        pc_side = _norm_bp_side(pc.get('Round') or pc.get('round'))
        try:
            pc_forecast = float(pc.get('Forecast') or 0)
        except (TypeError, ValueError):
            pc_forecast = 0.0

    decided = decide_road_signal(payload)
    dec_side = decided.get('side')
    dec_conf = float(decided.get('confidence') or 0)
    dec_unstable = bool(decided.get('unstable'))

    # Road percent server + forecast cao → hô theo road
    if pc_side in ('B', 'P') and pc_forecast >= 68:
        if dec_side == pc_side and dec_conf >= 0.52:
            return pc_side
        if dec_side != pc_side and dec_conf >= 0.62:
            return dec_side
        return pc_side

    if dec_side in ('B', 'P'):
        if not dec_unstable and dec_conf >= 0.55:
            return dec_side
        if dec_conf >= 0.62:
            return dec_side

    if pc_side in ('B', 'P') and pc_forecast >= 65:
        return pc_side

    # Fallback AI blocks
    for key in ('ai1', 'ai2', 'ai3', 'ai4'):
        block = payload.get(key)
        if isinstance(block, dict):
            bpc = block.get('percentCurrent') or {}
            if isinstance(bpc, dict):
                side = _norm_bp_side(bpc.get('Round') or bpc.get('round'))
                if side:
                    return side
    if pc_side in ('B', 'P'):
        return pc_side
    return None



def latest_total_round(payload):
    rounds = payload.get('totalRound') if isinstance(payload, dict) else None
    if not isinstance(rounds, list) or not rounds:
        return None
    best = None
    best_stamp = None
    for r in rounds:
        if not isinstance(r, dict):
            continue
        try:
            st = int(r.get('stampTime')) if r.get('stampTime') is not None else None
        except (TypeError, ValueError):
            st = None
        if st is None:
            continue
        if best_stamp is None or st > best_stamp:
            best_stamp = st
            best = r
    if not best:
        return None
    side = road_to_side(best.get('roadFormat') or best.get('road'))
    return {
        'stampTime': best.get('stampTime'),
        'id': best.get('id'),
        'road': best.get('road'),
        'roadFormat': side,
        'len': len(rounds),
    }


def wait_new_bpt_round(table_name, before_stamp, timeout_s=120, poll_s=1.0):
    try:
        before_n = int(before_stamp) if before_stamp is not None else None
    except (TypeError, ValueError):
        before_n = None
    deadline = time.time() + timeout_s
    observed_baseline = before_n
    last_pause_check = 0.0
    while time.time() < deadline:
        now = time.time()
        if now - last_pause_check >= 5:
            last_pause_check = now
            get_active_table_api()
            if globals().get('_system_paused'):
                print("[WAIT RESULT] hệ thống đang recover — dừng chờ ván", flush=True)
                return None
        payload = get_table_by_name_api(table_name)
        cur = latest_total_round(payload)
        if cur and cur.get('roadFormat') in ('B', 'P', 'T'):
            try:
                cur_n = int(cur.get('stampTime'))
            except (TypeError, ValueError):
                cur_n = None
            if cur_n is None:
                time.sleep(poll_s)
                continue
            if before_n is not None:
                if cur_n > before_n:
                    return cur
            else:
                if observed_baseline is None:
                    observed_baseline = cur_n
                elif cur_n > observed_baseline:
                    return cur
        time.sleep(poll_s)
    return None


def place_bet_api(table_name, bet_side, bet_amount=None):
    try:
        body = {"tableName": table_name, "betSide": bet_side}
        if bet_amount is not None:
            body["betAmount"] = float(bet_amount)
        res_data = api_post_json(
            '/api/place-bet',
            body,
            timeout=5,
        )
        print(
            f"[API PLACE BET] bàn {table_name} ({bet_side}) "
            f"mức={format_profit_k(bet_amount)}K -> {res_data}",
            flush=True,
        )
        return res_data
    except Exception as e:
        print(f"[API PLACE BET ERROR] {e}", flush=True)
        return None


def request_capture_now_api(table_name):
    try:
        res_data = api_post_json(
            '/api/request-capture-now',
            {"tableName": table_name},
            timeout=5,
        )
        print(f"[API CAPTURE REQUEST] {table_name} -> {res_data}", flush=True)
        return res_data
    except Exception as e:
        print(f"[API CAPTURE REQUEST ERROR] {e}", flush=True)
        return None


def request_session_restart_api():
    """Yêu cầu Playwright session restart (sau 60s không có API kết quả)."""
    try:
        ns = get_name_service()
        res_data = api_post_json(
            '/api/request-session-restart',
            {'nameService': ns},
            timeout=5,
        )
        print(f"[API RESTART SESSION] {res_data}", flush=True)
        return res_data
    except Exception as e:
        print(f"[API RESTART SESSION ERROR] {e}", flush=True)
        return None

TELE_OUT_LOG = os.path.join('logs', 'tele_out.log')
TIMING_LOG = os.path.join('logs', 'timing_flow.log')


def _now_ts():
    return datetime.now().strftime('%H:%M:%S.%f')[:-3]


def log_timing(event, detail='', t0=None):
    """Log nhịp luồng: API → capture → ảnh → hô → place-bet."""
    try:
        os.makedirs('logs', exist_ok=True)
        elapsed = ''
        if t0 is not None:
            elapsed = f" +{time.time() - t0:.2f}s"
        line = f"[{_now_ts()}]{elapsed} [{event}] {detail}".rstrip()
        with open(TIMING_LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
        print(f"[TIMING]{elapsed} [{event}] {detail}", flush=True)
        return time.time()
    except Exception as e:
        print(f"[TIMING LOG ERR] {e}", flush=True)
        return time.time()


def log_tele(kind, content):
    """Ghi mọi tin bot gửi vào nhóm — để soi spam / lệch nhịp."""
    try:
        os.makedirs('logs', exist_ok=True)
        ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        text = str(content or '').replace('\r\n', '\n').strip()
        if len(text) > 800:
            text = text[:800] + '…'
        line = f"[{ts}] [{kind}]\n{text}\n{'='*60}\n"
        with open(TELE_OUT_LOG, 'a', encoding='utf-8') as f:
            f.write(line)
        print(f"[TELE OUT] {kind} | {text.splitlines()[0] if text else ''}", flush=True)
    except Exception as e:
        print(f"[TELE OUT LOG ERR] {e}", flush=True)


async def send_result_image(group, result_type, caption, table_name=None, screenshot_data=None, jpeg_path=None):
    """Chỉ gửi ảnh THẬT (sexy_/screenshots). Không gửi mock."""
    send_path = None
    src_path = None

    if jpeg_path and os.path.exists(jpeg_path):
        send_path = jpeg_path
        src_path = jpeg_path
    else:
        if screenshot_data and is_real_screenshot_path(screenshot_data.get('filepath')):
            src_path = screenshot_data['filepath']
        if not src_path and table_name:
            src_path = get_real_screenshot_path(table_name)
        if not is_real_screenshot_path(src_path):
            print("[TELE ẢNH] BỎ QUA — chưa có ảnh thật (không gửi ảnh ảo)", flush=True)
            log_tele('ANH_SKIP', f'no real screenshot table={table_name} caption={caption}')
            return False
        send_path = compress_image_for_telegram(src_path) or src_path

    t0 = time.time()
    if TOKEN_BOT and HO_VIA_BOT:
        await asyncio.to_thread(
            bot_api_broadcast_photo, send_path, caption or '', 'HTML'
        )
        elapsed = time.time() - t0
        print(
            f"[BOT ẢNH] broadcast xong {elapsed:.1f}s | {os.path.basename(send_path)} "
            f"| groups={get_broadcast_chat_ids()}",
            flush=True,
        )
    else:
        await get_client().send_file(
            group,
            send_path,
            caption=caption or '',
            parse_mode='html',
            force_document=False,
            allow_cache=False,
        )
        elapsed = time.time() - t0
        print(f"[TELE ẢNH] THẬT gửi xong {elapsed:.1f}s | {os.path.basename(send_path)}", flush=True)
    log_tele(
        'ANH',
        f"file={os.path.basename(src_path or send_path)} elapsed={elapsed:.1f}s\n{caption}",
    )
    if send_path != src_path and 'tele_' in os.path.basename(str(send_path)):
        try:
            os.remove(send_path)
        except OSError:
            pass
    return True


def compress_image_for_telegram(image_path, max_width=900, quality=48):
    """Resize + JPEG nhẹ để send_file Tele nhanh — chỉ nén capture thật."""
    try:
        from PIL import Image
        import tempfile

        if not image_path or not os.path.exists(image_path):
            return None
        base = os.path.basename(str(image_path))
        if not base.startswith('tele_') and not is_real_screenshot_path(image_path):
            print(f"[COMPRESS] từ chối ảnh ảo: {image_path}", flush=True)
            return None
        with Image.open(image_path) as im:
            im = im.convert('RGB')
            w, h = im.size
            if w > max_width:
                nh = int(h * (max_width / float(w)))
                im = im.resize((max_width, nh), Image.Resampling.BILINEAR)
            fd, out_path = tempfile.mkstemp(prefix='tele_', suffix='.jpg')
            os.close(fd)
            im.save(out_path, format='JPEG', quality=quality, optimize=True)
            try:
                sz = os.path.getsize(out_path)
                print(f"[COMPRESS] {base} → {sz/1024:.0f}KB jpeg", flush=True)
            except OSError:
                pass
            return out_path
    except Exception as e:
        print(f"[COMPRESS SKIP] {e}", flush=True)
        return None


async def prepare_pending_image(pending, max_wait_seconds=8):
    """Chờ ảnh capture THẬT đúng stamp + đúng winner API — tuyệt đối không dùng mock."""
    if not pending:
        return pending
    if pending.get('jpeg_path') and os.path.exists(pending['jpeg_path']):
        return pending

    table = pending.get('table_name')
    min_stamp = pending.get('min_stamp_time')
    expect_winner = pending.get('expect_winner')
    data = pending.get('screenshot_data')
    if not data or not is_real_screenshot_path(data.get('filepath')):
        data = await get_real_screenshot_data_async(
            table,
            min_stamp_time=min_stamp,
            max_wait_seconds=max_wait_seconds,
            poll_s=0.25,
            expect_winner=expect_winner,
        )
        if data:
            pending['screenshot_data'] = data

    src = None
    if data and is_real_screenshot_path(data.get('filepath')):
        src = data['filepath']

    if not src:
        print(
            f"[PREPARE ẢNH] Chưa có ảnh THẬT bàn {table} "
            f"(stamp>={min_stamp} winner={expect_winner}) — bỏ ảnh",
            flush=True,
        )
        pending['jpeg_path'] = None
        pending['screenshot_data'] = None
        return pending

    jpeg = await asyncio.to_thread(compress_image_for_telegram, src)
    if jpeg:
        pending['jpeg_path'] = jpeg
        print(
            f"[PREPARE ẢNH] Sẵn sàng ảnh THẬT: {os.path.basename(src)} "
            f"winner={data.get('resultWinner')}",
            flush=True,
        )
    return pending


async def send_ho_message(group, bet_msg):
    """Gửi tin hô tới mọi GROUP (Bot API) hoặc 1 nhóm (userbot)."""
    t0 = time.time()
    if TOKEN_BOT and HO_VIA_BOT:
        await asyncio.to_thread(bot_api_broadcast_text, bet_msg, 'HTML')
        log_tele('HO', bet_msg)
        print(f"[BOT HÔ] broadcast xong {time.time()-t0:.2f}s | groups={get_broadcast_chat_ids()}", flush=True)
        return group
    client = get_client()
    try:
        await client.send_message(group, bet_msg, parse_mode='html')
    except Exception as e_bet:
        print(f"[HÔ ERROR] {e_bet}", flush=True)
        group = await resolve_group_entity(os.getenv('GROUP'))
        await client.send_message(group, bet_msg, parse_mode='html')
    log_tele('HO', bet_msg)
    print(f"[TELE HÔ] gửi xong {time.time()-t0:.2f}s", flush=True)
    return group


async def send_announce_message(group, announce_msg):
    if TOKEN_BOT and HO_VIA_BOT:
        # Bot API: Markdown → HTML đơn giản cho ổn định
        html_msg = (
            announce_msg.replace('**', '<b>', 1).replace('**', '</b>', 1)
            if '**' in announce_msg
            else announce_msg
        )
        # convert remaining ** pairs
        while '**' in html_msg:
            html_msg = html_msg.replace('**', '<b>', 1).replace('**', '</b>', 1)
        await asyncio.to_thread(bot_api_broadcast_text, html_msg, 'HTML')
        log_tele('BAO_BAN', announce_msg)
        return group
    client = get_client()
    try:
        await client.send_message(group, announce_msg, parse_mode='markdown')
    except Exception:
        group = await resolve_group_entity(os.getenv('GROUP'))
        await client.send_message(group, announce_msg, parse_mode='markdown')
    log_tele('BAO_BAN', announce_msg)
    return group


async def flush_result_image_now(group, pending):
    """API đã có kết quả → chờ ảnh new_round cùng winner → gửi (1 ảnh / 1 round)."""
    if not pending:
        return group
    await prepare_pending_image(pending, max_wait_seconds=20)
    has_real = bool(pending.get('jpeg_path')) or is_real_screenshot_path(
        (pending.get('screenshot_data') or {}).get('filepath')
    )
    if not has_real:
        print("[ANH] Skip — không có ảnh thật khớp API winner", flush=True)
        log_tele(
            'ANH_SKIP',
            f"after API result table={pending.get('table_name')} "
            f"expect={pending.get('expect_winner')}",
        )
        return group
    try:
        await send_result_image(
            group,
            pending.get('result_type'),
            pending.get('caption'),
            table_name=pending.get('table_name'),
            screenshot_data=pending.get('screenshot_data'),
            jpeg_path=pending.get('jpeg_path'),
        )
    except Exception as e:
        print(f"[SEND ẢNH ERROR] {e}", flush=True)
        log_tele('ANH_ERR', str(e))
    return group


async def send_message(text):
    """Send a text message to the channel"""
    try:
        await bot.send_message(
            chat_id=CHANNEL_ID,
            text=text
        )
        print(f"Sent message: {text} at {datetime.now()}")
    except Exception as e:
        print(f"Error sending message: {e}")

async def send_photo(image_path, caption=None):
    """Send a photo to the channel"""
    try:
        with open(image_path, 'rb') as photo:
            await bot.send_photo(
                chat_id=CHANNEL_ID,
                photo=photo,
                caption=caption
            )
        print(f"Posted image {image_path} at {datetime.now()}")
    except Exception as e:
        print(f"Error sending photo: {e}")

async def send_video(video_path):
    """Send a video to the channel"""
    try:
        with open(video_path, 'rb') as video:
            await bot.send_video(
                chat_id=CHANNEL_ID,
                video=video
            )
        print(f"Posted video {video_path} at {datetime.now()}")
    except Exception as e:
        print(f"Error sending video: {e}")

async def send_rotating_post(time_slot, result_type, caption=None):
    """Send rotating post for a specific time slot and result type, with optional caption"""
    posts = load_posts()
    rotating_posts = posts['rotating_posts'][result_type].get(time_slot, [])
    
    if not rotating_posts:
        print(f"No rotating posts available for time slot {time_slot} and result type {result_type}")
        return
    
    next_index = get_next_rotating_post_index(time_slot, result_type)
    post = rotating_posts[next_index]
    
    try:
        await send_photo(post['image_path'], caption)
    except Exception as e:
        print(f"Error sending rotating post: {e}")

def get_result_type(choice):
    """Get result type so that 75% là win đúng với bên được hô, còn lại là lose"""
    rand = random.random()
    if rand < 0.75:
        # Win đúng với bên được hô
        if choice == 'NHÀ CÁI 500K':
            return 'wincai'
        else:
            return 'wincon'
    else:
        # Lose (25%)
        if choice == 'NHÀ CÁI 500K':
            return 'losecai'  # Cái hô nhưng Cái thua
        else:
            return 'losecon'  # Con hô nhưng Con thua


def build_result_payload(is_cai, is_win, is_tie, winner=None, unit=None):
    """Caption ảnh: Húp / Gãy / Hòa (HTML bold)."""
    u = int(unit if unit is not None else UNIT_DISPLAY)
    if is_tie or winner == 'T':
        return 'tie', f'⚖️ <b>Hòa + 0%</b>'
    if is_win:
        kind = 'wincai' if is_cai else 'wincon'
        return kind, f'🔥 <b>Húp + {u}</b>'
    kind = 'losecai' if is_cai else 'losecon'
    return kind, f'💥 <b>Gãy - {u}</b>'


BET_AMOUNT = float(os.getenv('BET_AMOUNT', '50') or '50')
# Số hiện trên tin hô / caption ảnh: TAY CÁI ( 1000), Húp +1000, Gãy -1000
UNIT_DISPLAY = int(float(os.getenv('UNIT_DISPLAY', '1000') or '1000'))
MARTINGALE_MULTIPLIERS = (1, 2, 4)
ROAD_ANALYSIS_WINDOW = int(os.getenv('ROAD_ANALYSIS_WINDOW', '20') or '20')
ROAD_ANALYSIS_MIN_BP = int(os.getenv('ROAD_ANALYSIS_MIN_BP', '20') or '20')
ROAD_ANALYSIS_MIN_CONF = float(os.getenv('ROAD_ANALYSIS_MIN_CONF', '0.72') or '0.72')
TELE_LINE = '--------»-----★--—-«--------'
UNSTABLE_ROAD_MESSAGE = (
    '⚠️ <b>CẦU CHƯA ỔN ĐỊNH</b>\n'
    'Tạm dừng 1 tay — hệ thống đang quét lại cầu.\n'
    'Vui lòng chờ tín hiệu chuẩn. 🔮\n'
    f'{TELE_LINE}'
)


def stake_for_level(level):
    """Mức cược tối đa 3 tay: 50 → 100 → 200 (theo UNIT_DISPLAY)."""
    idx = max(0, min(int(level or 0), len(MARTINGALE_MULTIPLIERS) - 1))
    return UNIT_DISPLAY * MARTINGALE_MULTIPLIERS[idx]


def daily_state_path():
    ns = (os.getenv('NAME_SERVICE') or 'NS1').strip().upper() or 'NS1'
    state_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
    os.makedirs(state_dir, exist_ok=True)
    return os.path.join(state_dir, f'daily_state_{ns}.json')


def announced_table_state_path():
    ns = (os.getenv('NAME_SERVICE') or 'NS1').strip().upper() or 'NS1'
    state_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
    os.makedirs(state_dir, exist_ok=True)
    return os.path.join(state_dir, f'last_announced_table_{ns}.json')


def load_last_announced_table():
    try:
        with open(announced_table_state_path(), 'r', encoding='utf-8') as f:
            data = json.load(f)
        table = str(data.get('table') or '').strip().upper()
        return table if table and table not in ('NONE', 'LOBBY') else None
    except Exception:
        return None


def save_last_announced_table(table_name):
    table = str(table_name or '').strip().upper()
    if not table or table in ('NONE', 'LOBBY'):
        return
    path = announced_table_state_path()
    tmp = f'{path}.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(
                {'table': table, 'updatedAt': int(time.time() * 1000)},
                f,
                ensure_ascii=False,
            )
        os.replace(tmp, path)
    except Exception as e:
        print(f'[BÁO BÀN STATE WARN] {e}', flush=True)


def current_pnl_day():
    return datetime.now(TZ).date().isoformat()


def load_daily_state():
    today = current_pnl_day()
    defaults = {
        'day': today,
        'total_profit': 0.0,
        'stake_level': 0,
        'prev_result_text': '—',
        'loss_streak': 0,
        'skip_next_round': False,
    }
    try:
        with open(daily_state_path(), 'r', encoding='utf-8') as f:
            state = json.load(f)
        if state.get('day') != today:
            return defaults
        return {
            'day': today,
            'total_profit': float(state.get('total_profit', 0) or 0),
            'stake_level': max(
                0,
                min(
                    int(state.get('stake_level', 0) or 0),
                    len(MARTINGALE_MULTIPLIERS) - 1,
                ),
            ),
            'prev_result_text': state.get('prev_result_text') or '—',
            'loss_streak': max(0, int(state.get('loss_streak', 0) or 0)),
            'skip_next_round': bool(state.get('skip_next_round', False)),
        }
    except Exception:
        return defaults


def save_daily_state(
    day,
    total_profit,
    stake_level,
    prev_result_text,
    loss_streak,
    skip_next_round,
):
    path = daily_state_path()
    temp_path = f'{path}.tmp.{os.getpid()}'
    payload = {
        'day': day,
        'total_profit': float(total_profit),
        'stake_level': int(stake_level),
        'prev_result_text': prev_result_text,
        'loss_streak': int(loss_streak),
        'skip_next_round': bool(skip_next_round),
    }
    try:
        with open(temp_path, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(temp_path, path)
    except Exception as e:
        print(f'[DAILY STATE WARN] Không lưu được state: {e}', flush=True)
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        except Exception:
            pass


def format_profit_k(amount):
    """Hiển thị số K: 50 / 232850 / -100"""
    try:
        n = float(amount)
    except (TypeError, ValueError):
        n = 0
    if abs(n - round(n)) < 1e-9:
        return str(int(round(n)))
    return f"{n:.2f}".rstrip('0').rstrip('.')


def build_ho_message(table_name, is_cai, bet_amount, prev_result_text, total_profit, unit=None):
    """Nội dung hô — HTML bold các chỗ quan trọng (Tele không hỗ trợ nháy màu thật)."""
    tay = '🔴 CÁI' if is_cai else '🔵 CON'
    table = str(table_name or '').strip().upper()
    u = int(unit if unit is not None else UNIT_DISPLAY)
    # Số tiền Tele = UNIT_DISPLAY (1000); BET_AMOUNT chỉ để PW chọn chip UI
    stake = format_profit_k(u)
    profit = format_profit_k(total_profit)
    prev = prev_result_text or '—'
    # Đổi icon kết quả cho dễ nhìn
    if prev == 'THẮNG':
        prev_show = '🟢 THẮNG'
    elif prev == 'THUA':
        prev_show = '🔴 THUA'
    elif prev == 'HÒA':
        prev_show = '⚖️ HÒA'
    else:
        prev_show = prev
    return (
        f"✅ TAY SAU ĐÁNH: <b>{tay}</b>\n"
        f"🔈ĐẶT CƯỢC: <b>{stake} K</b>\n"
        f"——————————————\n"
        f"⚡️KẾT QUẢ VÁN TRƯỚC: <b>{prev_show}</b>\n"
        f"💹TỔNG LÃI: <b>{profit} K</b>\n"
        f"BÀN SEXY TRUYỀN THỐNG <b>{table}</b>\n"
        f"--------»-----★--—-«--------\n"
        f"‼️Phân Chia Mức Cược Theo Vốn Của Bạn\n"
        f"➡️ Nên nhớ đi lệnh :  5% -10% để an toàn vốn"
    )


def apply_round_pnl(total_profit, bet_amount, is_win, is_tie, is_cai):
    """Cộng/trừ lãi theo kết quả ván (Cái thắng tính 0.95)."""
    stake = float(bet_amount or 0)
    if is_tie:
        return total_profit, 0.0
    if is_win:
        gain = stake * 0.95 if is_cai else stake
        return total_profit + gain, gain
    return total_profit - stake, -stake


async def get_message_content(username):
    """Lấy nội dung tin nhắn từ cuộc trò chuyện với user"""
    try:
        telegram_client = get_client()
        user = await telegram_client.get_entity(username)
        messages = []
        async for message in telegram_client.iter_messages(user, limit=20):
            if message.text:
                messages.append(message.text)
        return messages
    except Exception as e:
        print(f"Lỗi khi lấy nội dung tin nhắn: {e}")
        return None

async def daily_schedule(client, group):
    """
    Chạy liên tục — 3 loại tin:
      1) Báo bàn khi Playwright vào bàn
      2) Hô CON / CÁI theo percentCurrent.Round từ API FE
      3) Gửi ảnh capture khi có B/P/T mới
    HO_VIA_BOT=1 → gửi bằng BotFather (không cần OTP userbot).
    """
    try:
        if TOKEN_BOT and HO_VIA_BOT:
            print(
                f"\n=== BOT FATHER HÔ | token_bot=ON | groups={get_broadcast_chat_ids()} ===",
                flush=True,
            )
        else:
            if client is None:
                raise RuntimeError('Telethon client None — bat HO_VIA_BOT=1 hoac login PHONE')
            if not client.is_connected():
                print("Mất kết nối, đang thử kết nối lại...", flush=True)
                await client.connect()
                if not await client.is_user_authorized():
                    await login_client()
            me = await client.get_me()
            print(
                f"\n=== BOT TELE LIÊN TỤC | login={me.first_name} phone={phone} "
                f"| group={group} ===",
                flush=True,
            )

        last_announced_table = load_last_announced_table()
        if last_announced_table:
            print(
                f"[BÁO BÀN STATE] Đã báo {last_announced_table} trước đó — không báo trùng",
                flush=True,
            )
        round_count = 0
        bot_started_ms = int(time.time() * 1000)
        daily_state = load_daily_state()
        pnl_day = daily_state['day']
        total_profit = daily_state['total_profit']
        stake_level = daily_state['stake_level']
        prev_result_text = daily_state['prev_result_text']
        loss_streak = daily_state['loss_streak']
        skip_next_round = daily_state['skip_next_round']
        last_result_stamp = None
        last_ho_key = None
        last_stale_log_at = 0.0
        road_profile_cache = {}
        road_analysis_stamp = None
        last_road_log_at = 0.0
        print(
            "[FLOW] 1 bot | API kết quả → CAP → GỬI ẢNH NGAY → chờ Round → HÔ → đặt",
            flush=True,
        )
        print(
            f"[PNL] ngày={pnl_day} tổng={format_profit_k(total_profit)}K "
            f"| mức kế={format_profit_k(stake_for_level(stake_level))}K "
            f"| UNIT_DISPLAY={format_profit_k(UNIT_DISPLAY)}K",
            flush=True,
        )
        print(f"[TELE OUT] log file = {TELE_OUT_LOG}", flush=True)

        while True:
            today = current_pnl_day()
            if today != pnl_day:
                pnl_day = today
                total_profit = 0.0
                stake_level = 0
                prev_result_text = '—'
                loss_streak = 0
                skip_next_round = False
                save_daily_state(
                    pnl_day,
                    total_profit,
                    stake_level,
                    prev_result_text,
                    loss_streak,
                    skip_next_round,
                )
                print(
                    f"[PNL DAILY RESET] 00:00 GMT+7 ngày {pnl_day} → tổng lãi = 0",
                    flush=True,
                )

            active = get_active_table_api()
            if not active:
                await asyncio.sleep(1)
                continue

            target_table = active['table']
            ready_at = active.get('readyAt')
            if last_announced_table is None and ready_at is not None:
                try:
                    if int(ready_at) < bot_started_ms - 120000:
                        print(
                            f"[WAIT BÀN] Bàn {target_table} quá cũ lúc bot start — chờ notify mới",
                            flush=True,
                        )
                        await asyncio.sleep(1)
                        continue
                except (TypeError, ValueError):
                    pass

            if target_table != last_announced_table:
                road_profile_cache.pop(target_table, None)
                road_analysis_stamp = None
                if last_announced_table is None:
                    announce_msg = (
                        f"🎰 <b>BÁO BÀN: {target_table}</b>\n"
                        f"AE vào đúng bàn <b>{target_table}</b> theo lệnh.\n"
                        f"{TELE_LINE}"
                    )
                    log_label = f"[BÁO BÀN] lần đầu → {target_table}"
                else:
                    announce_msg = (
                        f"🔄 <b>ĐỔI BÀN: {last_announced_table} → {target_table}</b>\n"
                        f"AE chuyển sang bàn <b>{target_table}</b>.\n"
                        f"{TELE_LINE}"
                    )
                    log_label = f"[ĐỔI BÀN] {last_announced_table} → {target_table}"
                last_result_stamp = None
                last_ho_key = None
                print(
                    f"[PNL] Giữ tổng lãi {format_profit_k(total_profit)}K "
                    f"khi chuyển sang bàn {target_table}",
                    flush=True,
                )
                try:
                    group = await send_announce_message(group, announce_msg)
                    print(log_label, flush=True)
                    last_announced_table = target_table
                    save_last_announced_table(target_table)
                except Exception as e_ann:
                    print(f"[BÁO/ĐỔI BÀN ERROR] {e_ann}", flush=True)
                    try:
                        if not (TOKEN_BOT and HO_VIA_BOT):
                            group = await resolve_group_entity(os.getenv('GROUP'))
                        group = await send_announce_message(group, announce_msg)
                        last_announced_table = target_table
                        save_last_announced_table(target_table)
                        print(f"[BÁO BÀN RETRY OK] {log_label}", flush=True)
                    except Exception as e2:
                        print(f"[BÁO BÀN RETRY FAIL] {e2}", flush=True)
                try:
                    table_payload = await asyncio.to_thread(
                        get_table_by_name_api, target_table
                    )
                    profile = analyze_road_profile(table_payload)
                    road_profile_cache[target_table] = profile
                    latest_at_entry = latest_total_round(table_payload) or {}
                    road_analysis_stamp = latest_at_entry.get('stampTime')
                    print(
                        f"[PHÂN TÍCH CẦU] {target_table} type={profile.get('road_type')} "
                        f"ready={profile.get('ready')} conf={profile.get('confidence')} "
                        f"seq={profile.get('seq_display')} | {profile.get('trend')}",
                        flush=True,
                    )
                except Exception as e_road:
                    print(f"[PHÂN TÍCH CẦU ERROR] {e_road}", flush=True)
                await asyncio.sleep(0.3)

            round_side = None
            before_payload = {}
            before_stamp = None
            signal_is_fresh = False
            road_decision = None
            round_wait_deadline = time.time() + 60
            while time.time() < round_wait_deadline:
                active_now = get_active_table_api()
                if (
                    not active_now
                    or str(active_now.get('table') or '').upper() != str(target_table).upper()
                ):
                    print(
                        "[WAIT API] Mất bàn / hệ thống đang recover — dừng hô",
                        flush=True,
                    )
                    signal_is_fresh = False
                    break
                before_payload = await asyncio.to_thread(get_table_by_name_api, target_table)
                before = latest_total_round(before_payload) or {}
                before_stamp = before.get('stampTime')

                profile = analyze_road_profile(before_payload)
                road_profile_cache[target_table] = profile
                if not profile.get('ready'):
                    if time.time() - last_road_log_at >= 8:
                        last_road_log_at = time.time()
                        print(
                            f"[PHÂN TÍCH CẦU] {target_table} không đạt chuẩn "
                            f"type={profile.get('road_type')} "
                            f"({profile.get('hand_count')}/{ROAD_ANALYSIS_MIN_BP}) "
                            f"conf={profile.get('confidence')} — đổi ngay",
                            flush=True,
                        )
                    await asyncio.to_thread(
                        request_change_table_api,
                        target_table,
                        profile.get('reason') or 'cầu chưa đạt chuẩn',
                    )
                    road_profile_cache.pop(target_table, None)
                    signal_is_fresh = False
                    await asyncio.sleep(2)
                    break
                # Hô theo cửa cầu đẹp đã chốt (ưu tiên profile.side)
                if road_analysis_stamp is not None and before_stamp is not None:
                    try:
                        if int(before_stamp) <= int(road_analysis_stamp):
                            if time.time() - last_road_log_at >= 8:
                                last_road_log_at = time.time()
                                print(
                                    f"[PHÂN TÍCH CẦU] {target_table} chờ ván mới "
                                    f"sau phân tích 20 tay (stamp={before_stamp})",
                                    flush=True,
                                )
                            await asyncio.sleep(1.2)
                            continue
                    except (TypeError, ValueError):
                        pass

                road_decision = decide_road_signal(before_payload)
                # Ưu tiên cửa từ phân tích cầu đẹp; ensemble chỉ hỗ trợ khi thiếu
                profile_side = profile.get('side')
                if (
                    profile_side in ('B', 'P')
                    and float(profile.get('confidence') or 0) >= ROAD_ANALYSIS_MIN_CONF
                ):
                    round_side = profile_side
                else:
                    round_side = road_decision.get('side') if road_decision else None
                    if round_side not in ('B', 'P'):
                        round_side = read_round_side(before_payload)
                if round_side in ('B', 'P'):
                    try:
                        round_age_s = (
                            (time.time() * 1000 - int(before_stamp)) / 1000
                            if before_stamp is not None
                            else 10**9
                        )
                    except (TypeError, ValueError):
                        round_age_s = 10**9
                    if round_age_s > 180:
                        if time.time() - last_stale_log_at >= 15:
                            last_stale_log_at = time.time()
                            print(
                                f"[WAIT API STALE] {target_table} totalRound cũ "
                                f"{round_age_s:.0f}s — không hô, không out bàn",
                                flush=True,
                            )
                        await asyncio.sleep(2)
                        continue
                    # Cầu quá yếu → bỏ ván này, chờ cầu rõ hơn
                    if (
                        road_decision
                        and road_decision.get('unstable')
                        and float(road_decision.get('confidence') or 0) < 0.58
                    ):
                        if time.time() - last_stale_log_at >= 10:
                            last_stale_log_at = time.time()
                            print(
                                f"[CẦU YẾU] {target_table} conf={road_decision.get('confidence')} "
                                f"seq={road_decision.get('seq_tail')} "
                                f"reason={road_decision.get('reason')} — bỏ tín hiệu",
                                flush=True,
                            )
                        await asyncio.sleep(1.2)
                        continue
                    ho_key = f"{target_table}|{round_side}|{before_stamp}"
                    if ho_key == last_ho_key:
                        await asyncio.sleep(0.4)
                        continue
                    signal_is_fresh = True
                    break
                print(
                    f"[WAIT API] {target_table} chưa có Round B/P — poll lại...",
                    flush=True,
                )
                await asyncio.sleep(0.35)

            if not signal_is_fresh:
                print(
                    "[WAIT API] Chưa có tín hiệu round mới — giữ nguyên bàn, không restart",
                    flush=True,
                )
                await asyncio.sleep(3)
                continue

            if skip_next_round:
                skip_key = f"{target_table}|{round_side}|{before_stamp}"
                last_ho_key = skip_key
                print(
                    f"[BỎ 1 TAY] {target_table} Round={round_side} "
                    "— không hô, không đặt; chờ ván kết thúc",
                    flush=True,
                )
                skipped_round = await asyncio.to_thread(
                    wait_new_bpt_round, target_table, before_stamp, 60, 0.25
                )
                if not skipped_round:
                    print(
                        "[BỎ 1 TAY WARN] Chưa thấy kết quả — tiếp tục giữ trạng thái bỏ tay",
                        flush=True,
                    )
                    await asyncio.sleep(2)
                    continue
                skipped_stamp = skipped_round.get('stampTime')
                try:
                    last_result_stamp = int(skipped_stamp)
                except (TypeError, ValueError):
                    last_result_stamp = None
                skip_next_round = False
                last_ho_key = None
                save_daily_state(
                    pnl_day,
                    total_profit,
                    stake_level,
                    prev_result_text,
                    loss_streak,
                    skip_next_round,
                )
                print(
                    f"[BỎ 1 TAY XONG] winner={skipped_round.get('roadFormat')} "
                    "— ván kế tiếp hô lại từ 50K",
                    flush=True,
                )
                continue

            is_cai = round_side == 'B'
            side = 'B' if is_cai else 'P'
            label = 'CÁI' if is_cai else 'CON'
            current_stake = stake_for_level(stake_level)
            round_count += 1
            last_ho_key = f"{target_table}|{round_side}|{before_stamp}"
            if not road_decision:
                road_decision = decide_road_signal(before_payload)
            road_profile = road_profile_cache.get(target_table) or analyze_road_profile(before_payload)
            print(
                f"[CẦU] {target_table} → {label} conf={road_decision.get('confidence')} "
                f"profile={road_profile.get('road_type')}({road_profile.get('confidence')}) "
                f"unstable={road_decision.get('unstable')} "
                f"scores={road_decision.get('scores')} "
                f"seq={road_decision.get('seq_tail')} | {road_decision.get('reason')}",
                flush=True,
            )

            bet_msg = build_ho_message(
                target_table,
                is_cai,
                current_stake,
                prev_result_text,
                total_profit,
                unit=current_stake,
            )

            print(f"[FLOW] HÔ #{round_count} {label} (1 tin / round)...", flush=True)
            t_round = time.time()
            prev_api = globals().get('_last_api_result_at')
            gap_api = f" (cách API result trước +{t_round - prev_api:.1f}s)" if prev_api else ""
            log_timing(
                'HO_START',
                f"#{round_count} {target_table} {label} Round={round_side}{gap_api}",
                t_round,
            )
            group = await send_ho_message(group, bet_msg)
            t_ho_done = log_timing(
                'HO_SENT',
                f"#{round_count} {label} tele ok",
                t_round,
            )
            print(
                f"[2/3 HÔ] #{round_count} {target_table} Round={round_side} → {label} "
                f"| prev={prev_result_text} lãi={format_profit_k(total_profit)}K",
                flush=True,
            )

            print("[FLOW] Place bet ngay sau hô...", flush=True)
            log_timing('PLACE_BET_START', f"#{round_count} side={side}", t_round)
            place_res = await asyncio.to_thread(
                place_bet_api, target_table, side, current_stake
            )
            log_timing(
                'PLACE_BET_API',
                f"#{round_count} res={place_res}",
                t_round,
            )
            if not place_res or not place_res.get('success'):
                print(f"[PLACE BET WARN] {place_res} — chờ rồi thử lại", flush=True)
                last_ho_key = None
                round_count = max(0, round_count - 1)
                await asyncio.sleep(1)
                continue
            bet_start_time = time.time() * 1000

            print(
                f"[FE SYNC] Đợi totalRound mới B/P/T cho {target_table} "
                f"(before_stamp={before_stamp})...",
                flush=True,
            )
            log_timing(
                'WAIT_RESULT_START',
                f"#{round_count} before_stamp={before_stamp}",
                t_round,
            )
            new_round = await asyncio.to_thread(
                wait_new_bpt_round, target_table, before_stamp, 60, 0.25
            )
            if not new_round:
                print(
                    "[FE SYNC WARN] Timeout 60s không có API ván mới "
                    "→ giữ bàn và khóa tín hiệu cũ, không hô lặp",
                    flush=True,
                )
                log_timing('WAIT_RESULT_TIMEOUT', f"#{round_count}", t_round)
                await asyncio.sleep(3)
                continue

            winner = new_round.get('roadFormat')
            result_stamp = new_round.get('stampTime') or bet_start_time
            try:
                result_stamp_n = int(result_stamp)
            except (TypeError, ValueError):
                result_stamp_n = None

            if result_stamp_n is not None and result_stamp_n == last_result_stamp:
                print(f"[DEDUP] Bỏ qua kết quả stamp={result_stamp_n} đã xử lý", flush=True)
                await asyncio.sleep(0.5)
                continue

            t_api = log_timing(
                'API_RESULT',
                f"#{round_count} winner={winner} stamp={result_stamp} "
                f"(sau hô {time.time()-t_ho_done:.1f}s)",
                t_round,
            )
            print(
                f"[FE SYNC] Kết quả API={winner} stamp={result_stamp} "
                f"— CHỜ ảnh new_round (cùng P/B/T), KHÔNG force_capture lung tung",
                flush=True,
            )
            log_timing('CAPTURE_WAIT', f"#{round_count} expect_winner={winner}", t_api)

            if winner == 'T':
                is_win, is_tie = False, True
            elif (is_cai and winner == 'B') or ((not is_cai) and winner == 'P'):
                is_win, is_tie = True, False
            else:
                is_win, is_tie = False, False

            total_profit, pnl_delta = apply_round_pnl(
                total_profit, current_stake, is_win, is_tie, is_cai
            )
            if is_tie:
                prev_result_text = 'HÒA'
            elif is_win:
                prev_result_text = 'THẮNG'
            else:
                prev_result_text = 'THUA'

            ho_label = 'CÁI' if is_cai else 'CON'
            ra_label = {'B': 'CÁI', 'P': 'CON', 'T': 'HÒA'}.get(str(winner), '?')
            print(
                f"[PNL] Hô {ho_label} → FE={winner}({ra_label}) → {prev_result_text} "
                f"delta={format_profit_k(pnl_delta)}K | tổng={format_profit_k(total_profit)}K",
                flush=True,
            )

            result_type, result_caption = build_result_payload(
                is_cai, is_win, is_tie, winner=winner, unit=current_stake
            )
            completed_three_loss_cycle = False
            if is_tie:
                next_stake_level = stake_level
            elif is_win:
                next_stake_level = 0
                loss_streak = 0
            else:
                loss_streak += 1
                if stake_level >= len(MARTINGALE_MULTIPLIERS) - 1:
                    next_stake_level = 0
                    completed_three_loss_cycle = True
                    skip_next_round = True
                    loss_streak = 0
                else:
                    next_stake_level = stake_level + 1
            print(
                f"[GẤP THẾP] mức {format_profit_k(current_stake)}K "
                f"→ ván sau {format_profit_k(stake_for_level(next_stake_level))}K",
                flush=True,
            )
            stake_level = next_stake_level
            save_daily_state(
                pnl_day,
                total_profit,
                stake_level,
                prev_result_text,
                loss_streak,
                skip_next_round,
            )
            # min_stamp: lúc API ra kết quả (trừ buffer) — ảnh phải thuộc ván này
            pending = {
                'table_name': target_table,
                'min_stamp_time': max(0, int(time.time() * 1000) - 8000),
                'expect_winner': winner,
                'result_type': result_type,
                'caption': result_caption,
                'screenshot_data': None,
                'jpeg_path': None,
                'result_stamp': result_stamp,
            }
            group = await flush_result_image_now(group, pending)
            if completed_three_loss_cycle:
                try:
                    group = await send_announce_message(
                        group, UNSTABLE_ROAD_MESSAGE
                    )
                    print(
                        "[CẢNH BÁO CẦU] Đã thua đủ 3 tay "
                        "50K → 100K → 200K; ván tới bỏ 1 tay",
                        flush=True,
                    )
                except Exception as warning_error:
                    print(
                        f"[CẢNH BÁO CẦU ERROR] {warning_error}",
                        flush=True,
                    )
            shot = pending.get('screenshot_data') or {}
            shot_w = road_to_side(shot.get('resultWinner'))
            if shot_w and shot_w != winner:
                print(
                    f"[WARN MISMATCH] caption API={winner} nhưng ảnh winner={shot_w} "
                    f"— đã cố chờ khớp; kiểm tra session new_round",
                    flush=True,
                )
            t_img = log_timing(
                'ANH_SENT_OR_SKIP',
                f"#{round_count} type={result_type} api={winner} shot={shot_w} "
                f"(từ API result +{time.time()-t_api:.1f}s)",
                t_api,
            )
            if result_stamp_n is not None:
                last_result_stamp = result_stamp_n
            last_ho_key = None
            print(
                f"[3/3] #{round_count} FE={winner} type={result_type} — đã gửi ảnh; chờ Round hô tiếp",
                flush=True,
            )
            log_timing(
                'ROUND_DONE',
                f"#{round_count} total={time.time()-t_round:.1f}s — "
                f"ảnh xong → chờ Round hô tiếp (đặt cược ở hô kế)",
                t_round,
            )
            # neo cho round sau: khoảng cách API result → hô mới
            globals()['_last_api_result_at'] = t_api
            globals()['_last_anh_at'] = t_img
            globals()['_last_round_n'] = round_count

    except Exception as e:
        print(f"Lỗi trong daily_schedule: {e}", flush=True)
        if "disconnected" in str(e).lower():
            print("Phát hiện mất kết nối, đang thử kết nối lại...", flush=True)
            try:
                await client.connect()
                if not await client.is_user_authorized():
                    await login_client()
                print("Đã kết nối lại thành công!", flush=True)
            except Exception as reconnect_error:
                print(f"Không thể kết nối lại: {reconnect_error}", flush=True)
        raise

def add_fixed_post(time_slot, image_path):
    """Add a new fixed post for a specific time slot"""
    posts = load_posts()
    if time_slot not in posts['fixed_posts']:
        posts['fixed_posts'][time_slot] = []
    
    posts['fixed_posts'][time_slot].append({
        'image_path': image_path
    })
    save_posts(posts)

def add_rotating_post(time_slot, image_path, result_type=None):
    """Add a new rotating post for a specific time slot and result type, optionally explicit result_type"""
    filename = os.path.basename(image_path).lower()
    if result_type is None:
        if filename.startswith('win_'):
            result_type = 'wincai' if 'cai' in filename else 'wincon'
        elif filename.startswith('lose_'):
            result_type = 'losecai' if 'cai' in filename else 'losecon'
        elif filename.startswith('tie_'):
            result_type = 'tie'
        else:
            raise ValueError("Image filename must start with 'win_', 'lose_' or 'tie_'")
    posts = load_posts()
    if time_slot not in posts['rotating_posts'][result_type]:
        posts['rotating_posts'][result_type][time_slot] = []
    
    existing_paths = {p['image_path'] for p in posts['rotating_posts'][result_type][time_slot]}
    if image_path not in existing_paths:
        posts['rotating_posts'][result_type][time_slot].append({
            'image_path': image_path,
            'last_sent_index': -1
        })
        save_posts(posts)

def add_rotating_posts_from_directory():
    """Automatically add all image files from each result directory, regardless of filename prefix"""
    # Add wincai posts
    wincai_dir = WINCAI_IMAGES_DIR
    if os.path.exists(wincai_dir):
        for filename in os.listdir(wincai_dir):
            if not filename.startswith('.'):
                add_rotating_post('11:00', os.path.join(wincai_dir, filename), result_type='wincai')

    # Add losecai posts
    losecai_dir = LOSECAI_IMAGES_DIR
    if os.path.exists(losecai_dir):
        for filename in os.listdir(losecai_dir):
            if not filename.startswith('.'):
                add_rotating_post('11:00', os.path.join(losecai_dir, filename), result_type='losecai')

    # Add wincon posts
    wincon_dir = WINCON_IMAGES_DIR
    if os.path.exists(wincon_dir):
        for filename in os.listdir(wincon_dir):
            if not filename.startswith('.'):
                add_rotating_post('11:00', os.path.join(wincon_dir, filename), result_type='wincon')

    # Add losecon posts
    losecon_dir = LOSECON_IMAGES_DIR
    if os.path.exists(losecon_dir):
        for filename in os.listdir(losecon_dir):
            if not filename.startswith('.'):
                add_rotating_post('11:00', os.path.join(losecon_dir, filename), result_type='losecon')

    # Add tie posts
    tie_dir = TIE_IMAGES_DIR
    if os.path.exists(tie_dir):
        for filename in os.listdir(tie_dir):
            if not filename.startswith('.'):
                add_rotating_post('11:00', os.path.join(tie_dir, filename), result_type='tie')

def is_schedule_minute(hour, minute):
    return f"{hour:02d}:{minute:02d}" in TIME_SLOTS_SET


def is_within_schedule(hour, minute):
    """Kiem tra moc hien tai co nam trong danh sach ca da cau hinh hay khong."""
    return is_schedule_minute(hour, minute)


def generate_daily_slots():
    """Tao cac moc trong ngay theo gio bat dau/ket thuc va khoang cach (GMT+7)."""
    if SCHEDULE_INTERVAL <= 0:
        raise ValueError('SCHEDULE_INTERVAL phai lon hon 0')

    slots = []
    start_minutes = SCHEDULE_START_HOUR * 60 + SCHEDULE_START_MINUTE
    end_minutes = SCHEDULE_END_HOUR * 60 + SCHEDULE_END_MINUTE
    total_minutes = end_minutes - start_minutes

    # Ho tro khung gio qua ngay, vi du 12:15 -> 00:00 hom sau.
    if total_minutes < 0:
        total_minutes += 24 * 60

    minutes = start_minutes
    elapsed = 0
    while elapsed <= total_minutes:
        hour, minute = divmod(minutes % (24 * 60), 60)
        slots.append(f"{hour:02d}:{minute:02d}")
        minutes += SCHEDULE_INTERVAL
        elapsed += SCHEDULE_INTERVAL

    return slots


TIME_SLOTS = generate_daily_slots()
TIME_SLOTS_SET = set(TIME_SLOTS)
if not TIME_SLOTS:
    raise ValueError('Khong tao duoc TIME_SLOTS, vui long kiem tra cau hinh lich')
log(f"[INFO] Da tao {len(TIME_SLOTS)} ca: {TIME_SLOTS[0]} -> {TIME_SLOTS[-1]}")


def get_next_slot(now):
    """Tim ca tiep theo theo thu tu da cau hinh, ho tro moc qua ngay."""
    current_slot = f"{now.hour:02d}:{now.minute:02d}"
    if current_slot in TIME_SLOTS:
        current_index = TIME_SLOTS.index(current_slot)
        return TIME_SLOTS[(current_index + 1) % len(TIME_SLOTS)]

    current = now.hour * 60 + now.minute
    future_slots = []
    wrapped_slots = []
    for slot in TIME_SLOTS:
        h, m = map(int, slot.split(':'))
        slot_minutes = h * 60 + m
        if slot_minutes > current:
            future_slots.append((slot_minutes, slot))
        else:
            wrapped_slots.append((slot_minutes, slot))

    if future_slots:
        return min(future_slots)[1]
    return min(wrapped_slots)[1]


async def schedule_loop(entities):
    """Chay theo danh sach moc da cau hinh trong ngay (GMT+7)."""
    global sent_slots
    log(
        f"[INFO] Lich: bat dau {SCHEDULE_START_HOUR:02d}:{SCHEDULE_START_MINUTE:02d}, "
        f"moi {SCHEDULE_INTERVAL} phut, {len(TIME_SLOTS)} ca/ngay, "
        f"moc cuoi {TIME_SLOTS[-1]} GMT+7"
    )
    while True:
        now = datetime.now(TZ)
        hour = now.hour
        minute = now.minute
        in_window = is_within_schedule(hour, minute)
        on_slot = is_schedule_minute(hour, minute)

        log(
            f"[HEARTBEAT] {now.strftime('%H:%M:%S')} GMT+7 | "
            f"trong khung gio: {'CO' if in_window else 'KHONG'} | "
            f"moc {SCHEDULE_INTERVAL}p: {'CO' if on_slot else 'KHONG'} | "
            f"ca tiep: {get_next_slot(now)}"
        )

        if on_slot and in_window:
            slot_key = now.strftime('%Y-%m-%d %H:%M')
            if slot_key not in sent_slots:
                log(f"[INFO] Bat dau ca luc {slot_key} cho {len(entities)} nhom")
                await asyncio.gather(*(run_session_with_retry(get_client(), entity) for entity in entities))
                sent_slots.add(slot_key)
            else:
                log(f"[INFO] Ca {slot_key} da chay roi, bo qua")

        if hour == 0 and minute == 1:
            sent_slots = set()
            log("[INFO] Reset sent_slots cho ngay moi")

        await asyncio.sleep(60 - now.second)

async def send_now():
    """Chạy 1 vòng hô liên tục; tin hô/ảnh broadcast mọi GROUP qua Bot API (nếu bật)."""
    log(f"[HO TARGETS] Bot API groups={get_broadcast_chat_ids()} | HO_VIA_BOT={HO_VIA_BOT}")
    entity = None
    telegram_client = None
    if TOKEN_BOT and HO_VIA_BOT:
        entity = get_broadcast_chat_ids()[0] if get_broadcast_chat_ids() else None
        if entity is None:
            raise RuntimeError('GROUP rong — them id nhom vao .env')
    else:
        telegram_client = get_client()
        entities = await resolve_group_entities(os.getenv('GROUP'))
        entity = entities[0]
    while True:
        try:
            await daily_schedule(telegram_client, entity)
        except Exception as e:
            print(f"[LOOP ERROR] {e} — restart sau 5s...", flush=True)
            await asyncio.sleep(5)
            if telegram_client is not None:
                try:
                    if not telegram_client.is_connected():
                        await telegram_client.connect()
                    if not await telegram_client.is_user_authorized():
                        await login_client()
                except Exception as re:
                    print(f"[RECONNECT WARN] {re}", flush=True)
        await asyncio.sleep(2)

async def list_dialogs():
    """Lấy danh sách nhóm/channel mà userbot đang tham gia"""
    print("Danh sách nhóm/channel đang tham gia:")
    async for dialog in get_client().iter_dialogs():
        if isinstance(dialog.entity, (Channel, Chat)):
            print(f"Name: {dialog.name} | ID: {dialog.id} | Type: {type(dialog.entity).__name__} | Username: {getattr(dialog.entity, 'username', None)}")


async def main():
    """Main function to run the bot"""
    global client
    ensure_single_instance()
    atexit.register(release_lock)

    ensure_directories()
    add_rotating_posts_from_directory()
    log(f"Starting continuous Tele hô | HO_VIA_BOT={HO_VIA_BOT} | GROUP={group}")

    try:
        # BotFather only — không OTP / không Telethon userbot
        if TOKEN_BOT and HO_VIA_BOT:
            try:
                me = bot_api_json('getMe', {})
                uname = ((me.get('result') or {}).get('username') or '?')
                log(f"[BOT API] Login OK @{uname} | groups={get_broadcast_chat_ids()}")
            except Exception as e:
                log(f"[ERROR] TOKEN_BOT khong hop le / getMe fail: {e}")
                sys.exit(1)
            await send_now()
            return

        if not api_id or not api_hash:
            log("[ERROR] API_ID/API_HASH thieu — hoac bat HO_VIA_BOT=1 + TOKEN_BOT")
            sys.exit(1)

        client = TelegramClient(SESSION_NAME, api_id, api_hash)
        log("Dang ket noi Telegram userbot...")
        await login_client()
        configure_sqlite_session(client)
        me = await client.get_me()
        log(f"Dang nhap: {me.first_name} (@{me.username}) | phone={phone}")
        await list_dialogs()
        try:
            entities = await resolve_group_entities(os.getenv('GROUP'))
            log(f'Da lay {len(entities)} entity tu GROUP')
        except Exception as e:
            log(f"Loi khi lay entity tu .env: {e}")
            return
        await send_now()
    finally:
        if client is not None:
            try:
                await client.disconnect()
            except Exception:
                pass
        release_lock()

if __name__ == '__main__':
    asyncio.run(main())
