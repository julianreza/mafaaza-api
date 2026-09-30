# Mafaaza API — Admin Dashboard Toko Fried Chicken

REST API untuk mencatat penjualan, pengeluaran, dan laporan keuangan toko. Dibangun dengan **Bun + Elysia**, **PostgreSQL**, **Drizzle ORM**, dan dokumentasi **OpenAPI** (Scalar UI).

- Satu akun admin (tanpa peran), login JWT + refresh token berotasi.
- Menu (kategori & produk), penjualan per transaksi dengan nomor struk harian, void, idempotency key.
- Pengeluaran dengan kategori default dan unggah bukti/nota.
- Dashboard: ringkasan + perbandingan periode, tren, produk terlaris, rincian per metode/tipe/kategori/jam, rekap kas harian, ekspor CSV.
- Riwayat perubahan (audit) append-only.

Semua nominal dalam Rupiah (integer). Timestamp ISO 8601 UTC; parameter tanggal `YYYY-MM-DD` = hari bisnis **WIB (Asia/Jakarta)**.

## Prasyarat

- [Bun](https://bun.sh) ≥ 1.2 (`curl -fsSL https://bun.sh/install | bash`)
- Docker (untuk PostgreSQL lokal) — atau PostgreSQL 14+ yang sudah ada

## Setup

```bash
cp .env.example .env            # lalu ganti JWT_SECRET dan ADMIN_PASSWORD
docker compose up -d db         # PostgreSQL 16 di 127.0.0.1:5432
bun install
bun run db:migrate              # buat/upgrade skema
bun run db:seed                 # akun admin dari ADMIN_* + 11 kategori pengeluaran default
bun run dev                     # http://localhost:3000
```

Dokumentasi interaktif: [http://localhost:3000/openapi](http://localhost:3000/openapi) (spesifikasi JSON di `/openapi/json`). Klik **Authorize**, tempel `accessToken` dari `POST /api/v1/auth/login`.

Bun otomatis membaca `.env`. `bun run db:seed` aman dijalankan ulang: admin tidak dibuat dua kali dan password tidak ditimpa.

## Variabel lingkungan

| Variabel | Wajib | Default | Keterangan |
|---|---|---|---|
| `DATABASE_URL` | ya | — | `postgres://user:pass@host:5432/db` |
| `DATABASE_PREPARE` | tidak | `true` | `false` bila lewat pooler mode transaksi (Supabase port 6543) |
| `DATABASE_MIGRATION_URL` | tidak | = `DATABASE_URL` | koneksi sesi/langsung untuk `db:migrate` & `drizzle-kit` (Supabase port 5432) |
| `JWT_SECRET` | ya | — | minimal 32 karakter (`openssl rand -base64 48`) |
| `CORS_ORIGINS` | ya | — | origin frontend, dipisah koma |
| `PORT` / `HOST` | tidak | `3000` / `0.0.0.0` | pakai `HOST=127.0.0.1` agar hanya lokal |
| `ACCESS_TOKEN_TTL_SECONDS` | tidak | `900` | |
| `REFRESH_TOKEN_TTL_DAYS` | tidak | `7` | |
| `OPENAPI_ENABLED` | tidak | `true` | `false` di production untuk menyembunyikan `/openapi` |
| `UPLOAD_DIR` | tidak | `./storage/uploads` | lokasi file bukti pengeluaran |
| `TRUST_PROXY` | tidak | `false` | `true` bila di balik reverse proxy (IP dari `X-Forwarded-For`) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | untuk seed | — | password minimal 8 karakter |

Aplikasi menolak start bila variabel wajib hilang/tidak valid, dan bila database tidak bisa dihubungi. Migrasi **tidak** dijalankan otomatis saat start — jalankan `bun run db:migrate` saat deploy.

## Supabase

Selain PostgreSQL lokal, API bisa memakai Supabase Postgres. Supabase menyediakan dua endpoint pooler:

- **Port 6543 — mode transaksi** (IPv4): untuk runtime API. Mode ini tidak mendukung prepared statement, jadi set `DATABASE_PREPARE=false`.
- **Port 5432 — mode sesi**: untuk `bun run db:migrate` dan `drizzle-kit`, yang butuh state sesi. Isi di `DATABASE_MIGRATION_URL`.

```bash
# .env (jangan di-commit — sudah ada di .gitignore)
DATABASE_URL="postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?sslmode=require"
DATABASE_MIGRATION_URL="postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require"
DATABASE_PREPARE=false
```

Password database hanya ditulis di `.env` (atau secret platform deploy), tidak pernah di `.env.example` atau file lain yang di-commit. `sslmode=require` memastikan koneksi terenkripsi.

Urutan pertama kali:

```bash
bun run db:migrate   # lewat DATABASE_MIGRATION_URL (5432)
bun run db:seed      # lewat DATABASE_URL (6543)
bun run start
```

**Jangan** arahkan `TEST_DATABASE_URL` ke Supabase: test integrasi mengosongkan tabel (TRUNCATE).

## Perintah

| Perintah | Fungsi |
|---|---|
| `bun run dev` / `bun run start` | jalankan server (watch / normal) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run db:generate` | buat migrasi baru dari perubahan `src/db/schema` |
| `bun run db:migrate` | jalankan migrasi |
| `bun run db:seed` | seed admin + kategori pengeluaran |
| `bun run admin:reset-password` | reset password admin (lihat di bawah) |
| `bun test` / `bun run test:unit` | test unit + integrasi / unit saja |
| `bun run test:perf` | uji performa manual (30.000 transaksi) |

## Lupa password

Tidak ada reset lewat email. Di server:

```bash
bun run admin:reset-password                       # diminta password baru (tidak ditampilkan)
bun run admin:reset-password --password 'baru-123' # non-interaktif
```

Semua sesi login dibatalkan setelah reset.

## Test

Test integrasi memakai database PostgreSQL terpisah (`TEST_DATABASE_URL`, default `postgres://mafaaza:mafaaza@localhost:5433/mafaaza_test`). Database uji di-migrasi otomatis dan dikosongkan (TRUNCATE) oleh test — **jangan** arahkan ke database berisi data.

```bash
docker compose up -d db-test    # PostgreSQL uji di 127.0.0.1:5433 (tmpfs)
bun test
bun run test:perf               # opsional
```

## Struktur

```
src/
  app.ts               createApp(): plugin + semua modul
  index.ts             bootstrap server
  config/env.ts        validasi environment
  db/                  schema Drizzle, migrasi, seed
  lib/                 waktu WIB, uang, audit, CSV, rate-limit, error
  plugins/             request logger, error handler, auth macro, OpenAPI
  modules/<domain>/    routes.ts (HTTP + skema) dan service.ts (logika + query)
  scripts/             reset-password
tests/unit | integration | perf
```

## Developer tooling

Supabase agent skills (instruksi siap pakai untuk AI coding tools) ada di `.agents/skills/` dan di-symlink ke `.kiro/skills/`; versinya dicatat di `skills-lock.json`. Pasang ulang / perbarui dengan:

```bash
npx skills add supabase/agent-skills -y
```

Skills ini tidak masuk dependency `package.json` dan tidak ikut di-bundle ke aplikasi.

## Catatan operasional

- **Backup**: jadwalkan `pg_dump` harian, mis. `pg_dump "$DATABASE_URL" -Fc -f backup-$(date +%F).dump`, dan ikutkan folder `UPLOAD_DIR` (bukti pengeluaran).
- **Rate-limit login** (5 gagal / 15 menit per IP) disimpan di memori proses: hilang saat restart dan tidak dibagi antar instance. Jalankan **satu instance**; bila butuh multi-instance, pindahkan penghitung ke PostgreSQL.
- Jalankan di balik HTTPS (reverse proxy / platform hosting); aplikasi sendiri melayani HTTP.
- Log berupa JSON satu baris per request (tanpa query string, body, password, atau token).
