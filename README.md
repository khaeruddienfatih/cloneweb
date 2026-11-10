# Utasin

Web untuk membuat dan memposting **utas (thread) Threads** untuk jualan affiliate secara otomatis.
Utasnya ditulis oleh Claude, lalu diposting lewat Threads API resmi.

- **Masuk dengan Threads** — login sekali klik lewat OAuth resmi, tanpa password. Bisa menghubungkan beberapa akun.
- **Tulis utas dengan Claude** — isi produk + link affiliate, pilih gaya, Claude menulis utasnya. Semua post bisa diedit dulu.
- **Posting / jadwalkan** — utas diterbitkan post demi post dan tersambung otomatis sebagai balasan berantai.
- **Autopilot** — pada jam yang ditentukan, Claude menulis utas baru untuk produk yang paling lama belum dipromosikan dan langsung mempostingnya.

## Menjalankan

Butuh Node.js 20.12 atau lebih baru.

```bash
npm install
cp .env.example .env   # lalu isi nilainya
npm start
```

Buka `http://localhost:3000`.

Tanpa `THREADS_APP_ID`, aplikasi berjalan dalam **mode demo**: semua fitur bisa dicoba, tetapi posting hanya disimulasikan.

## Pengaturan (.env)

### 1. Claude API

Buat API key di [platform.claude.com](https://platform.claude.com) dan isi `ANTHROPIC_API_KEY`.
Model default `claude-opus-5-5`; ganti `CLAUDE_MODEL` ke `claude-sonnet-5-5` atau `claude-haiku-5-5` kalau ingin lebih hemat.

### 2. Threads API (untuk login dan posting sungguhan)

1. Buka [developers.facebook.com](https://developers.facebook.com) → **Create App** → pilih use case **Access the Threads API**.
2. Aktifkan izin `threads_basic` dan `threads_content_publish`.
3. Di pengaturan Threads API, isi **Redirect Callback URL** dengan `{BASE_URL}/auth/threads/callback`.
   Meta mewajibkan HTTPS, jadi untuk percobaan lokal pakai tunnel (mis. ngrok / cloudflared) dan isi `BASE_URL` dengan alamat https-nya.
4. Salin **Threads App ID** dan **Threads App Secret** ke `THREADS_APP_ID` dan `THREADS_APP_SECRET`.
5. Selama app masih mode Development, hanya akun yang ditambahkan sebagai **Threads Tester** yang bisa login.
   Supaya bisa dipakai akun siapa pun, ajukan App Review untuk kedua izin di atas.

## Yang perlu diketahui

- Batas Threads: 500 karakter per post, dan ada kuota posting per akun per 24 jam. Jangan pasang Autopilot terlalu rapat.
- Gambar harus berupa URL publik yang bisa diunduh server Threads.
- Autopilot memposting **tanpa pemeriksaan manual**. Claude diarahkan hanya memakai fakta dari deskripsi produk, jadi isi deskripsinya dengan akurat.
- Keterangan affiliate (`#affiliate`) aktif secara default. Sebagian besar program affiliate dan aturan platform mewajibkan pengungkapan ini.
- Data disimpan di `data/db.json` (token akses dienkripsi). Cocok untuk satu server; untuk skala besar ganti `src/store.js` dengan database.
- Token Threads berlaku 60 hari dan diperpanjang otomatis selama server berjalan.

## Struktur

```
server.js            rute HTTP, sesi, login
src/ai.js            prompt & pemanggilan Claude (structured output)
src/threadsApi.js    OAuth + publikasi Threads API
src/publisher.js     penerbit utas, penjadwal, Autopilot
src/store.js         penyimpanan JSON + enkripsi token
public/              antarmuka web (tanpa framework)
```
