#!/usr/bin/env bash
# Yangilash: zaxira -> uchala repo da git pull -> build + qayta ishga tushirish -> api health kutish.
# Ishlatish:            ./deploy/update.sh
# Pull siz (kod qo'lda ko'chirilgan bo'lsa):   SKIP_PULL=1 ./deploy/update.sh
set -euo pipefail

# ---- Papkalar (kerak bo'lsa tashqaridan o'zgartiring: ROOT_DIR=/srv/x ./deploy/update.sh) ----
ROOT_DIR="${ROOT_DIR:-/opt/yuksalish}"
BACKEND_DIR="${BACKEND_DIR:-$ROOT_DIR/Yuksalish_backend}"
ADMIN_DIR="${ADMIN_DIR:-$ROOT_DIR/Yuksalish_Front}"
PUBLIC_DIR="${PUBLIC_DIR:-$ROOT_DIR/Yuksalish-publik}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"   # soniya

cd "$BACKEND_DIR"
[ -f .env ] || { echo "XATO: $BACKEND_DIR/.env topilmadi" >&2; exit 1; }

echo "==> 1/4 Zaxira nusxa"
"$BACKEND_DIR/deploy/backup.sh"

echo "==> 2/4 Yangi kod"
if [ "${SKIP_PULL:-0}" = "1" ]; then
  echo "SKIP_PULL=1: git pull o'tkazib yuborildi"
else
  for d in "$BACKEND_DIR" "$ADMIN_DIR" "$PUBLIC_DIR"; do
    echo "--- $d"
    git -C "$d" pull --ff-only
  done
fi

echo "==> 3/4 Build va qayta ishga tushirish"
docker compose -f docker-compose.prod.yml up -d --build

echo "==> 4/4 api health kutilmoqda (${HEALTH_TIMEOUT}s gacha)"
deadline=$((SECONDS + HEALTH_TIMEOUT))
until docker compose -f docker-compose.prod.yml exec -T api node -e \
  "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "XATO: api ${HEALTH_TIMEOUT}s ichida sog'lom bo'lmadi. Loglar: docker compose logs --tail=100 api" >&2
    exit 1
  fi
  sleep 3
done

docker compose -f docker-compose.prod.yml ps
echo "Yangilash tugadi."
