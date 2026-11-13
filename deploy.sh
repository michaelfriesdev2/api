#!/bin/bash
# =============================================================
# deploy.sh – instalacja Bazy Wiedzy na czystym VPS (Ubuntu/Debian)
# Uruchom JEDEN RAZ jako root lub użytkownik z sudo:
#   bash deploy.sh
# =============================================================
set -e

APP_DIR="/opt/bazawiedzy"
PORT=6767
DOMAIN=""          # opcjonalnie: twoja domena, np. api.twojadomena.pl
                   # jeśli puste – nginx będzie działał tylko po IP

echo "=== [1/6] Aktualizacja systemu ==="
apt-get update -y && apt-get upgrade -y

echo "=== [2/6] Instalacja Node.js 22 LTS ==="
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v && npm -v

echo "=== [3/6] Instalacja PM2 i nginx ==="
npm install -g pm2
apt-get install -y nginx

echo "=== [4/6] Kopiowanie plików aplikacji ==="
mkdir -p "$APP_DIR"
# zakładamy że repo jest w tym samym katalogu co skrypt
cp -r api/. "$APP_DIR/"
mkdir -p "$APP_DIR/data" "$APP_DIR/uploads"
chown -R www-data:www-data "$APP_DIR/uploads" "$APP_DIR/data" 2>/dev/null || true

echo "=== [5/6] Instalacja zależności npm ==="
cd "$APP_DIR"
npm install --omit=dev

# ustaw hasło admina jeśli nie podane
if [ -z "$ADMIN_PASSWORD" ]; then
  echo ""
  echo "UWAGA: Nie ustawiłeś ADMIN_PASSWORD."
  echo "Hasło zostanie wygenerowane losowo i wypisane w logach PM2 przy pierwszym starcie."
  echo "Sprawdź je przez: pm2 logs bazawiedzy --lines 50"
  echo ""
fi

echo "=== [6/6] Uruchomienie przez PM2 ==="
cd "$APP_DIR"
pm2 delete bazawiedzy 2>/dev/null || true
pm2 start server.js \
  --name bazawiedzy \
  --env production \
  -- \
  2>/dev/null || \
PORT=$PORT pm2 start server.js --name bazawiedzy

# przekaż zmienne środowiskowe
pm2 delete bazawiedzy 2>/dev/null || true
PORT=$PORT \
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}" \
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}" \
pm2 start server.js --name bazawiedzy

pm2 save
pm2 startup | tail -1 | bash || true

echo ""
echo "=== Konfiguracja nginx ==="

if [ -n "$DOMAIN" ]; then
  SERVER_NAME="$DOMAIN"
else
  SERVER_NAME="_"
fi

cat > /etc/nginx/sites-available/bazawiedzy <<NGINX
server {
    listen 80;
    server_name $SERVER_NAME;

    # limit wielkości uploadu – 210 MB (nieco więcej niż MAX_FILE_SIZE w API)
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
nginx -t && systemctl reload nginx

echo ""
echo "============================================"
echo " Baza Wiedzy działa!"
echo " Panel admina: http://$(curl -s ifconfig.me 2>/dev/null || echo VPS_IP):80"
echo " Logi: pm2 logs bazawiedzy"
echo " Status: pm2 status"
echo "============================================"
echo ""
echo "Następny krok – HTTPS przez Let's Encrypt:"
echo "  apt-get install -y certbot python3-certbot-nginx"
echo "  certbot --nginx -d $DOMAIN"
