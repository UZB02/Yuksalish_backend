#!/usr/bin/env bash
# MongoDB kunlik zaxira nusxasi.
# Cron: 0 3 * * * /opt/yuksalish/Yuksalish_backend/deploy/backup.sh >> $HOME/yuksalish-backup.log 2>&1
# Tiklash: ../docs/DEPLOY.md dagi "Zaxiradan tiklash" bo'limi.
set -euo pipefail

# Backend papkasi (shu skriptning bir daraja yuqorisi): compose fayl va .env shu yerda
cd "$(dirname "$0")/.."

# .env ni `source` qilmaymiz (qiymatlarda maxsus belgilar bo'lsa shell buzilishi mumkin) — kerakli kalitlarni o'qiymiz
env_get() {
  local line
  line="$(grep -E "^$1=" .env | tail -n1 || true)"
  line="${line#*=}"
  line="${line%$'\r'}"
  line="${line#\"}"; line="${line%\"}"
  line="${line#\'}"; line="${line%\'}"
  printf '%s' "$line"
}

[ -f .env ] || { echo "XATO: $(pwd)/.env topilmadi" >&2; exit 1; }
MONGO_ROOT_USER="$(env_get MONGO_ROOT_USER)"
MONGO_ROOT_PASSWORD="$(env_get MONGO_ROOT_PASSWORD)"
[ -n "$MONGO_ROOT_USER" ] && [ -n "$MONGO_ROOT_PASSWORD" ] || { echo "XATO: .env da MONGO_ROOT_USER / MONGO_ROOT_PASSWORD yo'q" >&2; exit 1; }

DIR="${BACKUP_DIR:-$(env_get BACKUP_DIR)}"; DIR="${DIR:-/var/backups/yuksalish}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-$(env_get BACKUP_KEEP_DAYS)}"; KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%F_%H%M)"
TARGET="$DIR/yuksalish_${STAMP}.archive.gz"

mkdir -p "$DIR"
chmod 700 "$DIR"

# Avval vaqtinchalik faylga yoziladi: dump yarim qolsa, buzuq fayl zaxira bo'lib qolmasin
if ! docker compose -f docker-compose.prod.yml exec -T mongo mongodump \
  --username "$MONGO_ROOT_USER" --password "$MONGO_ROOT_PASSWORD" \
  --authenticationDatabase admin --db yuksalish --archive --gzip \
  > "$TARGET.tmp"; then
  rm -f "$TARGET.tmp"
  echo "XATO: mongodump bajarilmadi" >&2
  exit 1
fi

mv "$TARGET.tmp" "$TARGET"
find "$DIR" -name 'yuksalish_*.archive.gz' -mtime "+$KEEP_DAYS" -delete
echo "Zaxira tayyor: $TARGET ($(du -h "$TARGET" | cut -f1))"
