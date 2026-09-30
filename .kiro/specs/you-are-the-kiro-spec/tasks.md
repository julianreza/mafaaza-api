# Tasks — Admin Dashboard API Toko Fried Chicken (mafaaza-api)

Urutan task mengikuti ketergantungan: fondasi → database → auth → master data → transaksi → laporan → dokumentasi & hardening. Setiap task selesai bila kodenya ada, `bun run typecheck` bersih, dan test yang disebut di task itu lulus. Rujukan `R<n>.<m>` ke `requirements.md`, `§` ke `design.md`.

## 1. Fondasi proyek

- [x] 1.1 Pasang Bun ≥ 1.2 di mesin dev (`curl -fsSL https://bun.sh/install | bash`) dan pastikan `bun --version` jalan; lalu `bun install`.
- [x] 1.2 Pin dependensi exact di `package.json`: `elysia`, `@elysiajs/openapi`, `@elysiajs/cors`, `drizzle-orm`, `postgres`, `jose`; dev: `drizzle-kit`, `typescript`, `@types/bun`. Hapus `bun-types@latest` dan `elysia@latest`. Ganti `"module"` ke `src/index.ts`.
  - _R9.4, §1_
- [x] 1.3 Tambah script `package.json`: `dev`, `start`, `typecheck`, `db:generate`, `db:migrate`, `db:seed`, `admin:reset-password`, `test`, `test:unit`, `test:perf` (§10).
- [x] 1.4 Rapikan `tsconfig.json` (strict, `moduleResolution: "bundler"`, `types: ["bun"]`, `noEmit`), tambah `bunfig.toml` dengan `[test] preload = ["./tests/setup.ts"]`.
- [x] 1.5 Buat `docker-compose.yml` dengan service `db` (postgres:16-alpine, 5432, volume `pgdata`) dan `db-test` (5433, tmpfs). Tambah `.env.example` berisi semua variabel §5.1. Tambah `storage/` dan `.env` ke `.gitignore`.
  - _R9.9_
- [x] 1.6 Implementasi `src/config/env.ts`: skema TypeBox, default, validasi `JWT_SECRET` ≥ 32 karakter, parsing `CORS_ORIGINS` jadi array; gagal → cetak variabel yang salah dan `process.exit(1)`. Test unit: env valid ter-parse, env tanpa `DATABASE_URL` melempar error berisi nama variabel.
  - _R9.2_
- [x] 1.7 Implementasi `src/lib/logger.ts` (JSON satu baris: `level`, `time`, `msg`, field tambahan) dan `src/lib/errors.ts` (`AppError`, peta nama constraint → pesan 409).
  - _R8.5, R9.7_
- [x] 1.8 Implementasi `src/lib/time.ts` (`toBusinessDate`, `businessDayRangeUtc`, `todayBusinessDate`, `parseDateRange`, `previousPeriod`) dan `src/lib/pagination.ts`. Test unit: batas tengah malam WIB (`2026-09-29T16:59:59Z` → `2026-09-29`, `17:00:00Z` → `2026-09-30`), `from > to` ditolak, rentang 367 hari ditolak, periode pembanding 7 hari benar, `limit` > 100 dijepit/ditolak sesuai skema.
  - _R8.4, R8.7, R6.1, R6.2_

## 2. Kerangka aplikasi & plugin

- [x] 2.1 Buat `src/db/client.ts` (postgres.js pool `max: 10` + drizzle) dan `src/app.ts` dengan `createApp({ db, env })` yang mengembalikan instance Elysia; `src/index.ts` hanya bootstrap: loadEnv → cek koneksi DB (`SELECT 1`, gagal → exit 1) → buat `UPLOAD_DIR` → `listen` → handler `SIGTERM`/`SIGINT` untuk `app.stop()` dan tutup pool.
  - _R9.2, §10_
- [x] 2.2 Plugin `request-logger.ts`: request id (terima `X-Request-Id` klien bila `[A-Za-z0-9-]{8,64}`, jika tidak UUID baru), set header respons `X-Request-Id`, log `method`, `path` (tanpa query), `status`, `durationMs`.
  - _R9.7_
- [x] 2.3 Plugin `error-handler.ts` sesuai tabel §6 (VALIDATION → 422 dengan `details` per field, PARSE → 422, NOT_FOUND → 404, `AppError`, PG `23505`/`23503`/`23514`, fallback 500 generik + log stack). Tambah header keamanan `nosniff`, `Referrer-Policy`, `X-Frame-Options` (§7).
  - _R8.5, R8.6_
- [x] 2.4 Pasang `@elysiajs/cors` dengan allowlist `CORS_ORIGINS` dan header yang diizinkan (§2.2).
  - _R9.3_
- [x] 2.5 Plugin `openapi.ts`: info API, tag per domain, komponen `bearerAuth`, skema `ErrorResponse`; didaftarkan hanya bila `OPENAPI_ENABLED=true`.
  - _R8.1, R8.2_
- [x] 2.6 Modul `health`: `GET /health` → 200 `{status:"ok",db:"ok"}` atau 503 `{status:"degraded",db:"down"}`.
  - _R9.1_
- [x] 2.7 Test integrasi: `/health` 200; route tak dikenal → 404 format error standar; body JSON rusak → 422 `INVALID_BODY`; origin tidak terdaftar tidak mendapat header `Access-Control-Allow-Origin`; `OPENAPI_ENABLED=false` → `/openapi` dan `/openapi/json` 404; `/openapi/json` valid saat aktif.
  - _R8.1, R8.2, R8.5, R9.1, R9.3_

## 3. Skema database, migrasi, seed

- [x] 3.1 Tulis skema Drizzle di `src/db/schema/` untuk enum (`payment_method`, `order_type` = `TAKE_AWAY`/`ONLINE`, `sale_status`) dan tabel `admins`, `refresh_tokens`, `product_categories`, `products`, `sales`, `sale_items`, `receipt_counters`, `idempotency_keys`, `expense_categories`, `expenses`, `audit_logs` beserta semua CHECK, unique index `lower(...)`, index parsial, dan FK RESTRICT sesuai §3.2.
  - _R2, R3, R4, R5, R7_
- [x] 3.2 `drizzle.config.ts` + `bun run db:generate` untuk migrasi awal; tambah migrasi SQL kustom berisi fungsi & trigger `BEFORE UPDATE OR DELETE ON audit_logs` yang `RAISE EXCEPTION`. Commit folder `src/db/migrations`.
  - _R7.3, R9.4_
- [x] 3.3 `src/db/migrate.ts` (drizzle migrator) dan verifikasi `bun run db:migrate` berjalan dari DB kosong.
  - _R9.4_
- [x] 3.4 `src/db/seed.ts`: buat admin dari `ADMIN_EMAIL`/`ADMIN_PASSWORD`/`ADMIN_NAME` hanya bila tabel `admins` kosong (tidak menimpa password); insert 11 kategori pengeluaran default dengan `ON CONFLICT DO NOTHING`; aman dijalankan berulang.
  - _R1.1, R5.1_
- [x] 3.5 `tests/setup.ts` dan `tests/helpers.ts`: migrasi DB uji (`TEST_DATABASE_URL`) sekali, `TRUNCATE ... RESTART IDENTITY CASCADE` sebelum tiap file, `createTestApp()`, `seedAdmin()`, `loginAsAdmin()` → header Authorization, factory produk/kategori/penjualan/pengeluaran.
  - _R9.8_
- [x] 3.6 Test integrasi DB: seed dua kali → tetap 1 admin dan 11 kategori, password tidak berubah; `UPDATE`/`DELETE` langsung ke `audit_logs` gagal; CHECK `total = subtotal - discount` dan `qty >= 1` menolak data salah.
  - _R1.1, R5.1, R7.3_

## 4. Riwayat perubahan (audit) — pustaka

- [x] 4.1 `src/lib/audit.ts`: `writeAudit(tx, { action, entityType, entityId, before, after, ctx })` + fungsi redaksi rekursif untuk key sensitif (§5.8). Helper `auditContext(request, server)` mengambil IP (hormati `TRUST_PROXY`) dan user agent (dipotong 255).
  - _R7.1, R7.2, R7.5_
- [x] 4.2 Test unit redaksi: objek bersarang dengan `password`, `refreshToken`, `tokenHash` terhapus, field lain utuh.
  - _R7.5_

## 5. Autentikasi admin

- [x] 5.1 `src/lib/rate-limit.ts` (in-memory, 5 gagal / 15 menit per IP → kunci 15 menit, reset saat sukses, pembersihan berkala `unref`). Test unit dengan jam palsu: gagal ke-5 mengunci, ke-6 ditolak, terbuka lagi setelah 15 menit, sukses menghapus counter.
  - _R1.5_
- [x] 5.2 Service token: terbit access JWT (`jose`, HS256, `sub`, `iss`, `aud`, `jti`, TTL env) dan refresh token opaque 32 byte (simpan SHA-256).
  - _R1.3_
- [x] 5.3 `POST /api/v1/auth/login`: cek kunci IP (429 + `Retry-After`), cari admin via `lower(email)`, verifikasi dummy bila tidak ditemukan, pesan generik 401, audit `auth.login_success`/`auth.login_failed`.
  - _R1.3, R1.4, R1.5, R7.1_
- [x] 5.4 `POST /api/v1/auth/refresh` dengan rotasi dalam transaksi `FOR UPDATE`; token revoked dipakai lagi → revoke semua + audit `auth.refresh_reuse_detected` + 401; kedaluwarsa/tidak ada → 401.
  - _R1.6, R1.7_
- [x] 5.5 `POST /api/v1/auth/logout` (204, idempoten).
  - _R1.8_
- [x] 5.6 Plugin `auth.ts`: macro `auth: true`, verifikasi JWT, tolak token dengan `iat` sebelum `password_changed_at`, cache admin 30 detik yang dibersihkan saat profil/password berubah; pasang ke grup `/api/v1` kecuali login & refresh.
  - _R1.9_
- [x] 5.7 `GET /api/v1/auth/me`, `PATCH /api/v1/auth/me` (name, email; audit `admin.profile_updated`), `POST /api/v1/auth/change-password` (verifikasi lama, 8–72 karakter, beda dari lama, set `password_changed_at`, revoke semua refresh, audit `admin.password_changed`).
  - _R1.11, R1.12, R1.13_
- [x] 5.8 `src/scripts/reset-password.ts` (`--password` atau prompt stdin tanpa echo; set hash, revoke semua refresh, audit `admin.password_reset_cli`).
  - _R1.14_
- [x] 5.9 Test integrasi auth: login benar → token + profil tanpa `passwordHash`; email salah dan password salah → 401 dengan pesan identik; 5 gagal → 429; refresh rotasi (token lama jadi 401); reuse → semua sesi dicabut; logout → refresh 401; ganti password → access & refresh lama ditolak; tidak ada endpoint pembuatan user (POST `/api/v1/users` 404); script reset-password mengubah password dan mencabut sesi.
  - _R1.1–R1.14_
- [x] 5.10 Test "semua route terproteksi": iterasi `app.routes` dengan prefix `/api/v1` (kecuali login/refresh), panggil tanpa token → setiap route 401.
  - _R1.9_

## 6. Kategori produk & produk

- [x] 6.1 Model TypeBox + routes + service `product-categories`: GET (urut `sort_order, name`), POST, PATCH, DELETE (409 `CATEGORY_IN_USE` bila ada produk); audit tiap perubahan.
  - _R2.1, R2.6, R7.1_
- [x] 6.2 Model + routes + service `products`: GET daftar (filter `categoryId`, `isActive`, `q` dengan escape wildcard, paginasi), GET detail, POST, PATCH (termasuk `price`, `isActive`), DELETE (409 `PRODUCT_IN_USE` bila ada `sale_items`); audit dengan before/after.
  - _R2.2–R2.7, R7.1_
- [x] 6.3 Test integrasi: nama kategori duplikat beda huruf → 409; SKU duplikat → 409; produk tanpa SKU boleh banyak; filter & pencarian; hapus kategori terpakai → 409; hapus produk belum pernah dijual → 204.
  - _R2.1–R2.7_

## 7. Penjualan & void

- [x] 7.1 `src/lib/money.ts` (fungsi murni: gabung item duplikat, `lineTotal`, `subtotal`, `total`, validasi diskon, kembalian). Test unit: kasus normal, diskon = subtotal (total 0) boleh, diskon > subtotal ditolak, kas kurang ditolak, kas pas → kembalian 0, item duplikat digabung.
  - _R3.3, R3.4, R3.5_
- [x] 7.2 Model TypeBox `POST /api/v1/sales` (items 1–100, qty 1–999, `cashReceived` hanya untuk CASH, `orderType` default `TAKE_AWAY`, `soldAt` opsional, header `Idempotency-Key` opsional dengan pola `[A-Za-z0-9_-]{1,100}`).
  - _R3.1, R3.8_
- [x] 7.3 Service `createSale` sesuai alur §5.5: idempotensi (replay 201 + `Idempotent-Replayed: true`, beda body → 409, > 24 jam → dianggap baru), validasi `soldAt` tidak di masa depan, ambil produk + kategori, 422 `PRODUCT_UNAVAILABLE` dengan `details`, hitung via `money.ts`, nomor struk via upsert `receipt_counters`, insert sale + items (snapshot) + idempotency key + audit dalam satu transaksi, retry sekali bila bentrok key.
  - _R3.1–R3.9, R9.5_
- [x] 7.4 `GET /api/v1/sales` (filter `from`, `to`, `paymentMethod`, `orderType`, `status`, `q`; urut `sold_at DESC, id DESC`; `itemCount`) dan `GET /api/v1/sales/:id` (dengan items). Tidak mendaftarkan PATCH/DELETE.
  - _R3.10, R3.11, R4.4_
- [x] 7.5 `POST /api/v1/sales/:id/void` (`reason` 3–255, `FOR UPDATE`, 404/409 `ALREADY_VOIDED`, audit `sale.voided`).
  - _R4.1, R4.2_
- [x] 7.6 Test integrasi penjualan: harga diambil dari produk walau klien mengirim field harga (diabaikan skema); ubah harga produk tidak mengubah penjualan lama; produk nonaktif → 422 dan tidak ada baris `sales`/`sale_items`/`receipt_counters` yang tertulis; nomor struk `INV-YYYYMMDD-0001` di-reset hari berikutnya (pakai `soldAt` berbeda hari WIB); 20 request paralel → 20 nomor unik 0001–0020; replay idempotensi mengembalikan id sama dan hanya 1 baris; key sama body beda → 409; `soldAt` masa depan → 422; void → status VOIDED, void kedua → 409; PATCH/DELETE `/sales/:id` → 404.
  - _R3.1–R3.11, R4.1–R4.4_

## 8. Kategori pengeluaran & pengeluaran

- [x] 8.1 Routes + service `expense-categories`: GET (filter `isActive`), POST, PATCH (nama, `isActive`), DELETE (409 bila pernah dipakai termasuk yang soft-delete); audit.
  - _R5.2, R7.1_
- [x] 8.2 Routes + service `expenses`: POST (default tanggal hari ini WIB, tidak boleh masa depan, kategori aktif), GET daftar (filter + paginasi + `meta.totalAmount`), GET detail, PATCH, DELETE soft-delete (204); semua query memfilter `deleted_at IS NULL`; audit dengan before/after.
  - _R5.3, R5.5, R5.6, R5.7, R7.1_
- [x] 8.3 Upload bukti: `PUT /api/v1/expenses/:id/attachment` (maks 5 MB, verifikasi magic bytes JPEG/PNG/WEBP/PDF, simpan `UPLOAD_DIR/expenses/<id>/<uuid>.<ext>`), `GET` (stream dengan header §5.7), `DELETE` (204); audit upload/hapus.
  - _R5.4_
- [x] 8.4 Test integrasi: tanggal besok → 422; kategori nonaktif → 422; `totalAmount` sesuai filter; soft-delete hilang dari daftar dan detail 404 tapi baris masih ada; upload PNG valid lalu unduh dengan token → byte identik; unduh tanpa token → 401; file `.exe` berganti nama `.png` → 422; file 6 MB → 422; hapus kategori terpakai → 409.
  - _R5.1–R5.7_

## 9. Laporan & dashboard

- [x] 9.1 `GET /api/v1/reports/summary` (4 query paralel, `averageTicket`, `netProfit`, perbandingan `{current, previous, change, changePct}` dengan `changePct = null` bila previous 0).
  - _R6.1, R6.2_
- [x] 9.2 `GET /api/v1/reports/trend` (`generate_series` harian/bulanan, LEFT JOIN, bucket kosong = 0).
  - _R6.3_
- [x] 9.3 `GET /api/v1/reports/top-products` (default 10, maks 50; group per `product_id`, nama terkini dari `products`).
  - _R6.4_
- [x] 9.4 `GET /api/v1/reports/sales-breakdown` (per metode bayar, tipe pesanan, kategori snapshot, jam 0–23 WIB; semua nilai enum & 24 jam selalu hadir; field `basis`).
  - _R6.5_
- [x] 9.5 `GET /api/v1/reports/expense-breakdown` (total + persentase 2 desimal) dan `GET /api/v1/reports/cash-recap?date` (kas masuk, kas keluar, selisih, non-tunai per metode).
  - _R6.6, R6.7_
- [x] 9.6 Test integrasi laporan dengan fixture tetap (mis. 3 hari, 8 penjualan termasuk 1 VOIDED dan 1 berdiskon, 5 pengeluaran termasuk 1 dihapus) dan angka yang dihitung manual di test: summary + perbandingan, trend dengan hari kosong bernilai 0, top products, breakdown (jam memakai WIB), expense breakdown, cash recap; VOIDED dan pengeluaran terhapus tidak terhitung; jumlah `byPaymentMethod` = `netSales` summary; rentang > 366 hari → 422.
  - _R6.1–R6.7, R6.9, R4.3_

## 10. Ekspor CSV

- [x] 10.1 `src/lib/csv.ts`: escape RFC 4180, prefiks `'` untuk nilai berawalan `=`, `+`, `-`, `@`, BOM UTF-8, generator `ReadableStream` dari iterator batch. Test unit untuk koma, kutip, newline, dan injection.
  - _R6.8_
- [x] 10.2 `GET /api/v1/exports/sales.csv`, `sale-items.csv`, `expenses.csv` dengan kolom §5.11, keyset pagination 1.000 baris, `Content-Disposition` bernama rentang tanggal, deskripsi kolom di OpenAPI.
  - _R6.8_
- [x] 10.3 Test integrasi: header kolom sesuai urutan, jumlah baris = jumlah data rentang, VOIDED ikut dengan status, pengeluaran terhapus tidak ikut, `sold_at_wib` dalam WIB, deskripsi `=SUM(A1)` keluar sebagai `'=SUM(A1)`.
  - _R6.8_

## 11. Riwayat perubahan — endpoint

- [x] 11.1 `GET /api/v1/audit-logs` (filter `from`, `to`, `action`, `entityType`, `entityId`; urut `id DESC`; paginasi). Tidak ada route tulis.
  - _R7.3, R7.4_
- [x] 11.2 Test integrasi: setelah login gagal, buat produk, ubah harga, buat & void penjualan, buat/ubah/hapus pengeluaran → entri audit dengan aksi yang benar, before/after berisi perubahan, IP dan user agent terisi; tidak ada entri yang memuat string password atau token yang dipakai di test (cek `JSON.stringify` seluruh tabel); filter bekerja.
  - _R7.1–R7.5_

## 12. Dokumentasi OpenAPI & kontrak

- [x] 12.1 Lengkapi setiap route dengan `detail` (tag, summary, description, `security`), skema `response` per status termasuk `ErrorResponse`, dan contoh request/response untuk login, create sale, create expense, summary.
  - _R8.1_
- [x] 12.2 Test kontrak: parse `/openapi/json`; setiap path `/api/v1/*` kecuali login/refresh punya `security` bearer; setiap operasi punya minimal satu respons 2xx dan satu respons error; semua daftar memakai bentuk `{ data, meta }`.
  - _R8.1, R8.3, R8.4_

## 13. Performa & penutup

- [x] 13.1 `tests/perf/seed-30k.ts` (30.000 penjualan acak dalam 31 hari + pengeluaran) dan `tests/perf/reports.perf.ts` (tidak ikut `bun test` default; 50× summary 31 hari → p95 < 1 detik; 50× create sale → p95 < 300 ms); dijalankan via `bun run test:perf` terhadap `db-test`.
  - _R9.6_
- [x] 13.2 Perbarui `README.md`: prasyarat, `.env.example`, `docker compose up -d`, `bun install`, `db:migrate`, `db:seed`, `dev`, URL `/openapi`, cara menjalankan test, reset password via CLI, catatan backup `pg_dump` + `UPLOAD_DIR`, catatan bahwa rate-limit login in-memory (satu instance).
  - _R9.9_
- [x] 13.3 Verifikasi akhir: `bun run typecheck`, `bun test` lulus seluruhnya, jalankan alur manual dari README pada DB kosong (migrate → seed → login di `/openapi` → buat produk → penjualan → pengeluaran → summary), hapus `GET /` "Hello Elysia" dari template.
  - _R1–R9_
