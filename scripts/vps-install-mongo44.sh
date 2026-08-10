#!/usr/bin/env bash
# Cài MongoDB 4.4 local trên VPS freze (CPU không AVX + Ubuntu 22.04 thiếu libssl1.1)
#
# Usage:
#   cd /var/www/api-bcr/api-bcr
#   sudo bash scripts/vps-install-mongo44.sh
#
# Chỉ dùng Docker (bỏ qua .deb):
#   sudo bash scripts/vps-install-mongo44.sh --docker
#
# Env tùy chọn:
#   MONGO_ADMIN_USER=bcr_admin MONGO_ADMIN_PASS='...' \
#   MONGO_APP_USER=bcr_app MONGO_APP_PASS='...' \
#   sudo -E bash scripts/vps-install-mongo44.sh

set -euo pipefail

LOG="/var/log/mongo44-install.log"
MONGO_VER="4.4.29"
DEB_BASE="https://repo.mongodb.org/apt/ubuntu/dists/focal/mongodb-org/4.4/multiverse/binary-amd64"
LIBSSL_DEB="http://archive.ubuntu.com/ubuntu/pool/main/o/openssl/libssl1.1_1.1.1f-1ubuntu2.24_amd64.deb"

MONGO_ADMIN_USER="${MONGO_ADMIN_USER:-bcr_admin}"
MONGO_ADMIN_PASS="${MONGO_ADMIN_PASS:-}"
MONGO_APP_USER="${MONGO_APP_USER:-bcr_app}"
MONGO_APP_PASS="${MONGO_APP_PASS:-}"
USE_DOCKER=false

for arg in "$@"; do
  case "$arg" in
    --docker) USE_DOCKER=true ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *) echo "Unknown option: $arg (use --docker or --help)" >&2; exit 1 ;;
  esac
done

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }
die() { log "ERROR: $*"; exit 1; }

require_root() {
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || die "Chạy với sudo: sudo bash $0"
}

preflight() {
  log "========== Preflight =========="
  log "OS: $(. /etc/os-release && echo "$PRETTY_NAME")"
  log "Arch: $(uname -m)"
  if grep -q avx /proc/cpuinfo 2>/dev/null; then
    log "CPU: có AVX (Mongo 5+ OK, script vẫn cài 4.4 cho ổn định trên VPS cũ)"
  else
    log "CPU: KHÔNG có AVX — bắt buộc MongoDB 4.4"
  fi
  command -v wget >/dev/null || apt-get install -y wget ca-certificates
}

install_libssl11() {
  if dpkg -l libssl1.1 2>/dev/null | grep -q "^ii"; then
    log "libssl1.1: đã có"
    return 0
  fi

  log "libssl1.1: cài từ focal-security..."
  echo "deb [arch=amd64] http://security.ubuntu.com/ubuntu focal-security main" \
    > /etc/apt/sources.list.d/focal-security-mongo.list
  apt-get update -qq
  if apt-get install -y libssl1.1 >>"$LOG" 2>&1; then
    log "libssl1.1: apt OK"
    return 0
  fi

  log "libssl1.1: apt fail — tải .deb trực tiếp (.24)..."
  cd /tmp
  wget -q --show-progress -O libssl1.1.deb "$LIBSSL_DEB" \
    || die "Không tải được libssl1.1: $LIBSSL_DEB"
  dpkg -i libssl1.1.deb >>"$LOG" 2>&1 || apt-get -f install -y >>"$LOG" 2>&1
  dpkg -l libssl1.1 | grep -q "^ii" || die "libssl1.1 vẫn chưa cài được"
  log "libssl1.1: deb OK"
}

download_mongo_debs() {
  log "Download MongoDB ${MONGO_VER} debs..."
  cd /tmp
  local pkg deb url
  for pkg in mongodb-org-shell mongodb-org-tools mongodb-org-mongos mongodb-org-server mongodb-org; do
    deb="${pkg}_${MONGO_VER}_amd64.deb"
    url="${DEB_BASE}/${deb}"
    log "  -> $deb"
    wget -q --show-progress -O "$deb" "$url" || die "Không tải được $url"
    [[ -s "$deb" ]] || die "File rỗng: $deb"
  done
}

install_mongo_debs() {
  log "Cài dependencies + Mongo debs..."
  apt-get install -y libcurl4 libldap-2.5-0 libwrap0 libsasl2-2 >>"$LOG" 2>&1

  cd /tmp
  dpkg -i \
    mongodb-org-shell_"${MONGO_VER}"_amd64.deb \
    mongodb-org-tools_"${MONGO_VER}"_amd64.deb \
    mongodb-org-mongos_"${MONGO_VER}"_amd64.deb \
    mongodb-org-server_"${MONGO_VER}"_amd64.deb \
    mongodb-org_"${MONGO_VER}"_amd64.deb >>"$LOG" 2>&1 \
    || apt-get -f install -y >>"$LOG" 2>&1

  command -v mongod >/dev/null || die "mongod vẫn không có sau dpkg — xem $LOG"

  local ver
  ver="$(mongod --version 2>&1 | head -1)"
  log "Binary OK: $ver"
  echo "$ver" | grep -q "Illegal instruction" && die "CPU không chạy được binary Mongo — thử: sudo bash $0 --docker"

  for pkg in mongodb-org mongodb-org-server mongodb-org-shell mongodb-org-mongos mongodb-org-tools; do
    echo "${pkg} hold" | dpkg --set-selections 2>/dev/null || true
  done
}

write_mongod_conf() {
  log "Ghi /etc/mongod.conf..."
  cat > /etc/mongod.conf << 'EOF'
storage:
  dbPath: /var/lib/mongodb
  journal:
    enabled: true
  wiredTiger:
    engineConfig:
      cacheSizeGB: 1
systemLog:
  destination: file
  logAppend: true
  logRotate: reopen
  path: /var/log/mongodb/mongod.log
net:
  port: 27017
  bindIp: 127.0.0.1
processManagement:
  timeZoneInfo: /usr/share/zoneinfo
setParameter:
  diagnosticDataCollectionEnabled: false
EOF
}

start_mongod_service() {
  mkdir -p /var/lib/mongodb /var/log/mongodb
  chown -R mongodb:mongodb /var/lib/mongodb /var/log/mongodb
  systemctl daemon-reload
  systemctl enable mongod
  systemctl restart mongod
  sleep 2
  systemctl is-active --quiet mongod || {
    tail -30 /var/log/mongodb/mongod.log 2>/dev/null || true
    die "mongod service không start — xem journalctl -u mongod -n 50"
  }
  log "mongod service: active"
}

create_mongo_users() {
  if [[ -z "$MONGO_ADMIN_PASS" || -z "$MONGO_APP_PASS" ]]; then
    log "Bỏ qua tạo user (set MONGO_ADMIN_PASS + MONGO_APP_PASS để tạo tự động)"
    return 0
  fi

  log "Tạo user admin + app..."
  mongo --quiet <<MONGO
use admin
try {
  db.dropUser("$MONGO_ADMIN_USER");
} catch (e) {}
db.createUser({
  user: "$MONGO_ADMIN_USER",
  pwd: "$MONGO_ADMIN_PASS",
  roles: [{ role: "root", db: "admin" }]
});
try {
  db.dropUser("$MONGO_APP_USER");
} catch (e) {}
db.createUser({
  user: "$MONGO_APP_USER",
  pwd: "$MONGO_APP_PASS",
  roles: [{ role: "readWrite", db: "db_bacarat" }]
});
MONGO

  if ! grep -q '^security:' /etc/mongod.conf; then
    printf '\nsecurity:\n  authorization: enabled\n' >> /etc/mongod.conf
    systemctl restart mongod
    sleep 2
  fi

  mongo --quiet "mongodb://${MONGO_APP_USER}:${MONGO_APP_PASS}@127.0.0.1:27017/db_bacarat?authSource=admin" \
    --eval 'print("auth OK, db:", db.getName())' \
    || die "Test auth thất bại"
  log "User + auth: OK"
}

install_docker_mongo() {
  log "========== Docker fallback (mongo:4.4) =========="
  apt-get install -y docker.io >>"$LOG" 2>&1
  systemctl enable docker
  systemctl start docker

  docker rm -f mongo-local 2>/dev/null || true
  docker run -d \
    --name mongo-local \
    --restart unless-stopped \
    -p 127.0.0.1:27017:27017 \
    -v mongo_local_data:/data/db \
    mongo:4.4 >>"$LOG" 2>&1

  sleep 5
  docker exec mongo-local mongo --quiet --eval 'print("mongo version:", db.version())' \
    || die "Docker mongo không chạy — docker logs mongo-local"

  log "Docker mongo-local: OK trên 127.0.0.1:27017"
  log ".env gợi ý: URL_CONNECT_MONGODB=\"mongodb://127.0.0.1:27017/db_bacarat\""
}

health_check() {
  log "========== Health check =========="
  if $USE_DOCKER; then
    docker ps --filter name=mongo-local --format '{{.Names}} {{.Status}}'
    return 0
  fi

  mongod --version | head -1 | tee -a "$LOG"
  systemctl status mongod --no-pager | head -5 | tee -a "$LOG"

  if command -v mongo >/dev/null; then
    mongo --quiet --eval 'printjson({ ok: 1, version: db.version() })' | tee -a "$LOG"
  fi
}

print_next_steps() {
  log "========== XONG =========="
  cat <<EOF

Mongo local đã sẵn sàng.

1) Cập nhật .env (thay mật khẩu thật):
   URL_CONNECT_MONGODB="mongodb://${MONGO_APP_USER:-bcr_app}:PASS@127.0.0.1:27017/db_bacarat"

2) Migrate data từ Mongo cũ (nếu cần):
   mongodump --uri="mongodb://USER:PASS@HOST:27017/db_bacarat?authSource=admin" --out=/tmp/mongo-migrate
   mongorestore --uri="mongodb://127.0.0.1:27017" --db=db_bacarat /tmp/mongo-migrate/db_bacarat

3) Restart app:
   cd /var/www/api-bcr/api-bcr && pm2 stop all && bash scripts/vps-tune-production.sh

Log cài đặt: $LOG
EOF
}

main() {
  require_root
  : > "$LOG"
  log "========== MongoDB 4.4 local install =========="

  preflight

  if $USE_DOCKER; then
    install_docker_mongo
    health_check
    print_next_steps
    exit 0
  fi

  install_libssl11
  download_mongo_debs
  install_mongo_debs
  write_mongod_conf
  start_mongod_service
  create_mongo_users
  health_check
  print_next_steps
}

main "$@"
