# Shadow PingMax

Platform ping URL + keyword: mengirim sinyal XML-RPC `weblogUpdates.extendedPing` / `weblogUpdates.ping`
ke banyak server ping, plus IndexNow (Bing, Yandex, Naver, Seznam) opsional, dengan laporan status langsung per server.
Responsif di HP dan desktop, bisa ditambahkan ke layar utama (PWA). Tanpa dependensi npm, cukup Node.js 18+.

## Fitur
- Form kata kunci/judul + URL (sampai 20 URL per proses, satu per baris)
- Pilih kategori (multi). Kategori ikut dikirim sebagai tag dan menambah layanan khusus (Berita, Blog)
- Ping massal paralel, hasil tampil langsung (SSE): grid titik, hitungan, filter Berhasil/Gagal, log per URL
- Batalkan proses, unduh CSV, riwayat 100 proses terakhir
- Password akses, rate limit per IP, header keamanan (CSP), validasi input

## Jalankan cepat
```bash
cp .env.example .env      # isi ACCESS_PASSWORD dan SESSION_SECRET
node server.js            # buka http://IP-SERVER:3000
```

## Docker
```bash
cp .env.example .env
docker compose up -d --build
```

## VPS (systemd + Nginx + HTTPS)
```bash
sudo mkdir -p /opt/shadow-pingmax && sudo cp -r . /opt/shadow-pingmax
cd /opt/shadow-pingmax && sudo cp .env.example .env && sudo nano .env
sudo chown -R www-data:www-data /opt/shadow-pingmax/data
sudo cp deploy/shadow-pingmax.service /etc/systemd/system/
sudo systemctl enable --now shadow-pingmax
sudo cp deploy/nginx.conf /etc/nginx/sites-available/pingmax   # edit server_name
sudo ln -s /etc/nginx/sites-available/pingmax /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d pingmax.contoh.com
```
Di belakang Nginx, set `TRUST_PROXY=1` dan `COOKIE_SECURE=1` di `.env`.

## Dipakai dari GitHub Pages
Backend ini bisa dipakai oleh UI statis (paket `shadow-pingmax-pages`). Isi di `.env`:
```
ACCESS_PASSWORD=password-kuat
CORS_ORIGIN=https://USERNAME.github.io
```
Server harus diakses lewat HTTPS agar bisa dipanggil dari halaman Pages.

## Menambah / mengganti server ping
Edit `services.json` lalu restart. Format:
```json
{"id":"unik","name":"Nama","url":"http://server/RPC2","categories":["all"]}
```
`categories`: `["all"]` = selalu dipakai; atau daftar id kategori (`blog`, `news`, ...) = dipakai bila kategori itu dipilih.

## Catatan soal efektivitas
- Daftar bawaan berisi layanan ping publik yang umum dipakai. Sebagian bisa sudah mati; laporan status membantu Anda membuang yang selalu gagal dari `services.json`.
- Ping-O-Matic dan sejenisnya meneruskan ping ke server lain, tetapi jumlah "ratusan server" tidak bisa dijamin.
- Google sudah menghentikan endpoint ping. Untuk Google, gunakan sitemap + Google Search Console.
- Bing, Yandex, Naver, Seznam mendukung IndexNow: isi kolom IndexNow key (file key harus ada di domain Anda).
- Ping membantu penemuan URL, bukan jaminan terindeks. Jangan dipakai untuk spam dan hormati ketentuan tiap layanan.

## Konfigurasi (.env)
| Variabel | Default | Fungsi |
|---|---|---|
| PORT / HOST | 3000 / 0.0.0.0 | Alamat server |
| ACCESS_PASSWORD | kosong | Password masuk (wajib bila diakses publik) |
| SESSION_SECRET | acak | Kunci sesi (isi agar login tidak hilang saat restart) |
| MAX_URLS | 20 | Maks URL per proses |
| CONCURRENCY | 10 | Ping paralel |
| PING_TIMEOUT_MS | 12000 | Timeout per server |
| RATE_LIMIT_JOBS / RATE_WINDOW_MIN | 15 / 60 | Batas proses per IP |
| MAX_ACTIVE_JOBS | 3 | Proses bersamaan |
| TRUST_PROXY, COOKIE_SECURE | 0 | Aktifkan di belakang proxy HTTPS |

## API singkat
- `POST /api/ping` `{keyword, urls[], categories[], indexnowKey?}` → `{jobId}`
- `GET /api/jobs/:id/stream` (SSE: `start`, `result`, `done`)
- `POST /api/jobs/:id/cancel`, `GET /api/history`, `GET /healthz`
