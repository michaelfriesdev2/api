#!/bin/bash
# =============================================================
# deploy.sh – instalacja Bazy Wiedzy na czystym VPS (Ubuntu/Debian)
# Uruchom JEDEN RAZ jako root:
#   ADMIN_PASSWORD="haslo" bash deploy.sh
# =============================================================
set -e

APP_DIR="/opt/bazawiedzy"
PORT=6767
DOMAIN=""   # opcjonalnie: twoja domena, np. api.twojadomena.pl

echo "=== [1/6] Aktualizacja systemu ==="
apt-get update -y && apt-get upgrade -y

echo "=== [2/6] Instalacja Node.js 22 LTS ==="
# zawsze instaluj przez nodesource żeby mieć też npm
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
hash -r  # odśwież PATH
node -v && npm -v

echo "=== [3/6] Instalacja PM2 i nginx ==="
npm install -g pm2
apt-get install -y nginx

echo "=== [4/6] Kopiowanie plików aplikacji ==="
# skrypt uruchamiasz z /opt/bazawiedzy (root repo)
# pliki API są w podfolderze api/
mkdir -p "$APP_DIR/app"
cp -r api/. "$APP_DIR/app/"
mkdir -p "$APP_DIR/app/data" "$APP_DIR/app/uploads"

echo "=== [5/6] Instalacja zależności npm ==="
cd "$APP_DIR/app"
npm install --omit=dev

if [ -z "$ADMIN_PASSWORD" ]; then
  echo ""
  echo "UWAGA: Nie ustawiłeś ADMIN_PASSWORD."
  echo "Hasło zostanie wygenerowane losowo – sprawdź: pm2 logs bazawiedzy --lines 50"
  echo ""
fi

echo "=== [6/6] Uruchomienie przez PM2 ==="
cd "$APP_DIR/app"
pm2 delete bazawiedzy 2>/dev/null || true

PORT=$PORT \
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}" \
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}" \
pm2 start server.js --name bazawiedzy

pm2 save
pm2 startup | tail -1 | bash || true

echo ""
echo "=== Konfiguracja nginx ==="

SERVER_NAME="${DOMAIN:-_}"

cat > /etc/nginx/sites-available/bazawiedzy <<NGINX
server {
    listen 80;
    server_name $SERVER_NAME;
    client_max_body_size 210M;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/bazawiedzy /etc/nginx/sites-enabled/bazawiedzy
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo ""
echo "============================================"
echo " Baza Wiedzy działa!"
echo " Panel admina: http://$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
echo " Logi:   pm2 logs bazawiedzy"
echo " Status: pm2 status"
echo "============================================"
