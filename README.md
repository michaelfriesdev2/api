# Baza Wiedzy – API (VPS)

Backend do logowania, kategorii i uploadu plików na VPS. Frontend hostujesz **osobno** (folder `../frontend`, np. Cloudflare Pages) – ten serwer służy tylko jako API + magazyn plików.

## Stack
- Node.js + Express + Multer (upload) + JWT (logowanie)
- Hasła: scrypt (wbudowane w Node, bez zewnętrznych zależności natywnych)
- Pliki: dysk `uploads/<kategoria>/`, metadane: `data/db.json`

## Uruchomienie
```bash
cd api
npm install
npm start          # produkcja
npm run dev        # z auto-reload (node --watch)
```
Nasłuchuje na `0.0.0.0:3000` (zmień `PORT`/`HOST`).

### Zmienne środowiskowe
| Zmienna | Domyślnie | Opis |
|---|---|---|
| `PORT` | `3000` | port |
| `HOST` | `0.0.0.0` | bind |
| `ADMIN_USERNAME` | `admin` | login admina |
| `ADMIN_PASSWORD` | losowane | hasło admina (jeśli nie ustawisz – generowane losowo i wypisywane w konsoli przy pierwszym starcie) |
| `MAX_FILE_SIZE` | `209715200` (200 MB) | limit wielkości pliku w bajtach |
| `TOKEN_EXPIRY` | `7d` | ważność JWT |
| `FRONTEND_DIR` | — | opcjonalnie: ścieżka do frontendu, jeśli chcesz serwować go z tego API (zamiast Cloudflare Pages) |

## Pierwsze logowanie
Przy pierwszym starcie tworzone jest konto admina. Bez `ADMIN_PASSWORD` hasło jest generowane losowo i pokazane w konsoli. Zaloguj się i **zmień hasło**.

## Uruchomienie jako usługa na VPS (systemd)
`/etc/systemd/system/bazawiedzy.service`:
```ini
[Unit]
Description=Baza Wiedzy API
After=network.target

[Service]
WorkingDirectory=/opt/bazawiedzy/api
Environment=PORT=3000
Environment=ADMIN_USERNAME=admin
Environment=ADMIN_PASSWORD=ZMIEN_TO
ExecStart=/usr/bin/node server.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bazawiedzy
```

Albo przez PM2: `pm2 start server.js --name bazawiedzy-api`.

## Reverse proxy (nginx + HTTPS)
Frontend na Cloudflare Pages woła API cross-origin, więc CORS jest otwarty. Skieruj subdomenę API (np. `api.twojadomena.pl`) na port aplikacji:
```nginx
server {
  server_name api.twojadomena.pl;
  client_max_body_size 210M;   # nieco więcej niż MAX_FILE_SIZE
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```
Domyślnie przeglądanie/pobieranie są publiczne, a upload/zarządzanie wymaga logowania. Możesz wymusić logowanie do przeglądania: `PATCH /api/config {"requireAuthToView": true}`.

## API (skrót)
Wszystkie chronione endpointy wymagają nagłówka `Authorization: Bearer <token>`.

- `POST /api/auth/login` `{username,password}` → `{token,user}`
- `GET /api/auth/me` (auth) → `{user}`
- `POST /api/auth/password` (auth) `{oldPassword,newPassword}` → `{ok}`
- `GET /api/categories` → `{categories,uncategorizedCount}`
- `POST /api/categories` (auth) `{name,icon?,color?}` → `{category}`
- `PATCH /api/categories/:id` (auth) `{name?,icon?,color?}` → `{category}`
- `DELETE /api/categories/:id` (auth) → pliki tej kategorii → „Bez kategorii”
- `GET /api/files?category=&q=&page=&limit=` → `{total,page,limit,files}`
  - `category=all` = wszystko, `category=none` = bez kategorii
- `GET /api/files/:id` → `{file}`
- `GET /api/files/:id/download` → strumień pliku
- `POST /api/files` (auth, `multipart/form-data`) pola: `file`, `category`, `title`, `description` → `{file}`
- `DELETE /api/files/:id` (auth) → usuwa plik z dysku i metadane
- `GET /api/stats` → liczniki
- `PATCH /api/config` (auth) `{requireAuthToView}`

### Upload przez curl
```bash
TOKEN=$(curl -s -X POST https://api.twojadomena.pl/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"TWOJEHASLO"}' | jq -r .token)

curl -X POST https://api.twojadomena.pl/api/files \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/sciezka/plik.pdf" \
  -F "category=straz-pozarna" \
  -F "title=Rozkaz 01/2025" \
  -F "description=Szkolenie"
```
