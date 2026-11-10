# Utasin

Web untuk membuat dan memposting **utas (thread) Threads** untuk jualan affiliate secara otomatis.
Utasnya ditulis oleh Claude, diposting lewat Threads API resmi, dan seluruhnya berjalan di **Cloudflare Workers**.

- **Masuk dengan Threads** — login sekali klik lewat OAuth resmi, tanpa password. Bisa menghubungkan beberapa akun.
- **Tulis utas dengan Claude** — isi produk + link affiliate, pilih gaya, Claude menulis utasnya. Semua post bisa diedit dulu.
- **Posting / jadwalkan** — utas diterbitkan post demi post dan tersambung otomatis sebagai balasan berantai.
- **Autopilot** — pada jam yang ditentukan, Claude menulis utas baru untuk produk yang paling lama belum dipromosikan dan langsung mempostingnya.

## Deploy ke Cloudflare

### Cara A — dari dashboard (tanpa terminal)

1. Buka [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Import a repository**, lalu pilih repo ini.
2. Biarkan perintah deploy bawaan (`npx wrangler deploy`) dan klik **Deploy**.
   Database D1 bernama `utasin` dibuat otomatis, dan tabelnya dibuat sendiri oleh aplikasi saat pertama dibuka.
3. Setelah itu setiap push ke branch produksi otomatis ter-deploy.

### Cara B — dari terminal

```bash
npm install
npx wrangler login
npm run deploy
```

Web langsung aktif di `https://utasin.<subdomain-kamu>.workers.dev`. Domain sendiri bisa ditambahkan di
**Settings → Domains & Routes**.

### Isi secret

Di dashboard: **Workers & Pages → utasin → Settings → Variables and Secrets** (tipe *Secret*), atau lewat terminal:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put THREADS_APP_ID
npx wrangler secret put THREADS_APP_SECRET
```

| Secret | Dari mana |
| --- | --- |
| `ANTHROPIC_API_KEY` | [platform.claude.com](https://platform.claude.com) → API Keys |
| `THREADS_APP_ID`, `THREADS_APP_SECRET` | App Meta dengan use case **Access the Threads API** (lihat di bawah) |

Selama secret Threads belum diisi, web berjalan dalam **mode demo**: semua fitur bisa dicoba, tetapi posting hanya disimulasikan.

Pengaturan lain ada di `wrangler.jsonc` → `vars`: `TIMEZONE` (default `Asia/Jakarta`) dan `CLAUDE_MODEL`
(default `claude-opus-5-5`; ganti ke `claude-sonnet-5-5` atau `claude-haiku-5-5` kalau ingin lebih hemat).

### Menyiapkan Threads API

1. Buka [developers.facebook.com](https://developers.facebook.com) → **Create App** → pilih use case **Access the Threads API**.
2. Aktifkan izin `threads_basic` dan `threads_content_publish`.
3. Isi **Redirect Callback URL** dengan `https://<alamat-web-kamu>/auth/threads/callback`
   (alamat workers.dev atau domain sendiri — harus sama persis dengan alamat yang dibuka pengguna).
4. Salin **Threads App ID** dan **Threads App Secret** ke secret di atas.
5. Selama app masih mode Development, hanya akun yang ditambahkan sebagai **Threads Tester** yang bisa login.
   Supaya bisa dipakai akun siapa pun, ajukan App Review untuk kedua izin di atas.

## Menjalankan di komputer sendiri

```bash
npm install
cp .dev.vars.example .dev.vars   # isi nilainya
npm run dev                      # http://localhost:8787
```

Cron tidak berjalan sendiri saat lokal. Picu manual dengan membuka
`http://localhost:8787/__scheduled?cron=*+*+*+*+*`.

## Yang perlu diketahui

- **Posting berjalan lewat cron tiap menit.** "Posting sekarang" memasukkan utas ke antrean dan terbit dalam ±1 menit.
- **Paket Cloudflare.** Paket gratis membatasi waktu CPU 10 ms dan 50 subrequest per pemanggilan. Bila di log muncul
  error "exceeded CPU time limit" atau utas panjang gagal di tengah, pindah ke Workers Paid.
- Batas Threads: 500 karakter per post, dan ada kuota posting per akun per 24 jam. Jangan pasang Autopilot terlalu rapat.
- Gambar harus berupa URL publik yang bisa diunduh server Threads.
- Autopilot memposting **tanpa pemeriksaan manual**. Claude diarahkan hanya memakai fakta dari deskripsi produk, jadi isi deskripsinya dengan akurat.
- Keterangan affiliate (`#affiliate`) aktif secara default. Sebagian besar program affiliate dan aturan platform mewajibkan pengungkapan ini.
- Data disimpan di D1; token akses Threads dienkripsi. Token berlaku 60 hari dan diperpanjang otomatis oleh cron.
- Kalau penerbitan terhenti di tengah, utas ditandai gagal dan bisa diteruskan dengan tombol **Lanjutkan** tanpa mengulang post yang sudah terbit.

## Struktur

```
wrangler.jsonc       konfigurasi Worker: assets, D1, cron
src/worker.js        rute HTTP (Hono), sesi, login, handler cron
src/ai.js            prompt & pemanggilan Claude (structured output)
src/threadsApi.js    OAuth + publikasi Threads API
src/publisher.js     penerbit utas, penjadwal, Autopilot
src/db.js            penyimpanan D1
src/security.js      tanda tangan cookie & enkripsi token
public/              antarmuka web (tanpa framework)
```
