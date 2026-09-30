# Design — Admin Dashboard API Toko Fried Chicken (mafaaza-api)

Dokumen ini menjelaskan pendekatan teknis untuk memenuhi `requirements.md` (Requirement 1–9). Rujukan requirement ditulis sebagai `R<n>.<m>`.

## 1. Kondisi Awal & Keputusan Utama

Repo `mafaaza-api` masih template `bun create elysia`: satu file `src/index.ts` (`GET /` → "Hello Elysia"), `package.json` dengan `elysia@latest`, belum ada `node_modules`, belum ada database. Semua modul dibangun dari nol.

| Area | Pilihan | Alasan |
|---|---|---|
| Runtime | Bun ≥ 1.2 | Ditetapkan user; punya `Bun.password` (argon2id), `bun test`, `Bun.file` bawaan. |
| Framework | Elysia 1.4.x | Ditetapkan user; validasi TypeBox (`t`) sekaligus jadi skema OpenAPI. |
| Dokumentasi | `@elysiajs/openapi` (Scalar UI) | Path default `/openapi` dan `/openapi/json` sesuai R8.1. |
| Database | PostgreSQL 16 | Ditetapkan user; `generate_series`, `timestamptz`, `jsonb`. |
| ORM & migrasi | `drizzle-orm` + `drizzle-kit`, driver `postgres` (postgres.js) | Ditetapkan user; postgres.js ringan dan cocok dengan Bun. |
| Access token | `jose` (JWT HS256) | Standar, tanpa native binding. |
| Hash password | `Bun.password.hash(..., { algorithm: "argon2id" })` | Bawaan Bun, tanpa dependensi tambahan (R1.10). |
| CORS | `@elysiajs/cors` | Plugin resmi (R9.3). |
| Validasi env | TypeBox `Value.Check` dari `@sinclair/typebox` (ikut Elysia) | Satu sistem skema di seluruh proyek (R9.2). |
| Logging | Logger JSON kecil buatan sendiri di atas `console` | Cukup untuk R9.7 tanpa dependensi. |
| Test | `bun test` + database PostgreSQL uji | R9.8. |

Semua versi dependensi di-pin exact di `package.json` (tanpa `^`/`latest`); `elysia` diganti dari `latest` ke versi exact.

## 2. Arsitektur

Monolit modular: satu proses HTTP Elysia, satu database. Setiap domain adalah modul berisi `routes.ts` (definisi HTTP + skema), `service.ts` (logika bisnis + query Drizzle), `model.ts` (skema TypeBox request/response).

```
Frontend dashboard ──HTTPS──▶ Elysia app (Bun)
                                 ├─ plugins: requestLogger → cors → openapi → errorHandler → auth
                                 ├─ modules/*  (routes → service → Drizzle)
                                 └─ storage lokal (UPLOAD_DIR) untuk bukti pengeluaran
                                          │
                                   PostgreSQL 16
```

Route handler tidak berisi query; service tidak tahu tentang HTTP (menerima argumen biasa, melempar `AppError`). Service menerima parameter `db` (instance atau transaksi) agar dapat dites dan dipakai di dalam transaksi.

### 2.1 Struktur Direktori

```
mafaaza-api/
├─ docker-compose.yml              # postgres:16 untuk dev (5432) dan test (5433)
├─ drizzle.config.ts
├─ .env.example
├─ src/
│  ├─ index.ts                     # bootstrap: loadEnv → createApp → listen
│  ├─ app.ts                       # createApp(deps) — dipakai juga oleh test
│  ├─ config/env.ts                # skema & parsing env (R9.2)
│  ├─ db/
│  │  ├─ client.ts                 # koneksi postgres.js + drizzle
│  │  ├─ schema/                   # satu file per domain, re-export di index.ts
│  │  ├─ migrations/               # hasil drizzle-kit generate (di-commit)
│  │  ├─ migrate.ts                # bun run db:migrate
│  │  └─ seed.ts                   # bun run db:seed (R1.1, R5.1)
│  ├─ lib/
│  │  ├─ errors.ts                 # AppError + kode error
│  │  ├─ pagination.ts             # parse page/limit, bentuk meta
│  │  ├─ time.ts                   # konversi WIB ↔ UTC, business date
│  │  ├─ money.ts                  # hitung subtotal/total/kembalian
│  │  ├─ audit.ts                  # writeAudit(tx, entry) + redaksi
│  │  ├─ csv.ts                    # serialisasi CSV streaming
│  │  ├─ rate-limit.ts             # limiter login per IP
│  │  └─ logger.ts
│  ├─ plugins/
│  │  ├─ request-logger.ts
│  │  ├─ error-handler.ts
│  │  ├─ auth.ts                   # macro `auth: true` → derive `admin`
│  │  └─ openapi.ts
│  ├─ modules/
│  │  ├─ health/
│  │  ├─ auth/                     # login, refresh, logout, me, password
│  │  ├─ product-categories/
│  │  ├─ products/
│  │  ├─ sales/
│  │  ├─ expense-categories/
│  │  ├─ expenses/                 # termasuk upload bukti
│  │  ├─ reports/                  # dashboard, tren, rincian, rekap kas, CSV
│  │  └─ audit-logs/
│  └─ scripts/reset-password.ts    # bun run admin:reset-password (R1.14)
└─ tests/
   ├─ setup.ts                     # migrasi DB uji, truncate antar test
   ├─ helpers.ts                   # createTestApp, loginAsAdmin, factory data
   ├─ unit/                        # money, time, csv, rate-limit
   └─ integration/                 # per modul, via app.handle(Request)
```

### 2.2 Urutan Plugin & Siklus Request

1. `requestLogger` — buat `requestId` (header `X-Request-Id` jika dikirim klien dan valid, jika tidak `crypto.randomUUID()`), catat waktu mulai; pada `onAfterResponse` tulis satu baris JSON `{ level, time, requestId, method, path, status, durationMs }`. Query string tidak dicatat (bisa berisi data pencarian), body tidak pernah dicatat.
2. `cors` — `origin` = daftar `CORS_ORIGINS`, `credentials: false`, `allowedHeaders: ["Authorization","Content-Type","Idempotency-Key","X-Request-Id"]`.
3. `openapi` — didaftarkan hanya jika `OPENAPI_ENABLED=true`; bila tidak, route tidak ada sehingga otomatis 404 (R8.2).
4. `errorHandler` — `onError` global memetakan error ke format R8.5 (lihat §6).
5. `auth` — macro Elysia `auth: true` pada grup `/api/v1` (kecuali `/auth/login`, `/auth/refresh`): baca `Authorization: Bearer <jwt>`, verifikasi dengan `jose.jwtVerify` (HS256, `iss=mafaaza-api`, `aud=mafaaza-dashboard`), lalu pastikan admin `sub` masih ada; hasil `admin: { id, name, email }` tersedia di context. Gagal → 401 `UNAUTHORIZED` (R1.9).

## 3. Model Data

Konvensi: PK `uuid` (`gen_random_uuid()`), waktu `timestamptz` dalam UTC, uang `integer` (Rupiah, maks ±2,1 miliar per nilai — cukup untuk satu transaksi/pengeluaran), agregat dijumlahkan sebagai `bigint` lalu dikembalikan sebagai `number` (aman sampai 9×10¹⁵). Tanggal bisnis disimpan eksplisit sebagai kolom `date` yang dihitung aplikasi dari waktu WIB, supaya filter/agregasi harian tidak perlu konversi zona waktu di setiap query dan bisa di-index.

### 3.1 Enum PostgreSQL

| Enum | Nilai |
|---|---|
| `payment_method` | `CASH`, `QRIS`, `TRANSFER`, `EWALLET` |
| `order_type` | `TAKE_AWAY`, `ONLINE` |
| `sale_status` | `COMPLETED`, `VOIDED` |

### 3.2 Tabel

**`admins`** (R1)

| Kolom | Tipe | Keterangan |
|---|---|---|
| id | uuid PK | |
| name | varchar(100) not null | |
| email | varchar(254) not null | unique index pada `lower(email)` |
| password_hash | text not null | argon2id |
| password_changed_at | timestamptz not null default now() | |
| created_at, updated_at | timestamptz not null default now() | |

Hanya satu baris yang diharapkan; seed memeriksa `count(*) = 0` sebelum insert (R1.1). Tidak ada endpoint pembuatan (R1.2).

**`refresh_tokens`** (R1.6–R1.8, R1.13)

| Kolom | Tipe | Keterangan |
|---|---|---|
| id | uuid PK | |
| admin_id | uuid FK → admins ON DELETE CASCADE | |
| token_hash | char(64) not null unique | SHA-256 hex dari token opaque |
| expires_at | timestamptz not null | now + 7 hari |
| revoked_at | timestamptz null | |
| replaced_by | uuid null FK → refresh_tokens | rantai rotasi |
| created_at | timestamptz not null default now() | |
| user_agent | varchar(255) null | |
| ip | inet null | |

**`product_categories`** (R2.1, R2.6)

| Kolom | Tipe | Keterangan |
|---|---|---|
| id | uuid PK | |
| name | varchar(60) not null | unique index `lower(name)` |
| sort_order | integer not null default 0 | urutan tampil |
| created_at, updated_at | timestamptz | |

**`products`** (R2)

| Kolom | Tipe | Keterangan |
|---|---|---|
| id | uuid PK | |
| category_id | uuid not null FK → product_categories ON DELETE RESTRICT | |
| name | varchar(100) not null | |
| sku | varchar(40) null | unique index parsial `lower(sku) WHERE sku IS NOT NULL` |
| description | text null | |
| price | integer not null CHECK (price >= 0) | harga jual berlaku |
| is_active | boolean not null default true | |
| created_at, updated_at | timestamptz | |

Index: `(category_id)`, `(is_active)`, trigram tidak dipakai — pencarian nama `ILIKE` cukup untuk ratusan produk.

**`sales`** (R3, R4)

| Kolom | Tipe | Keterangan |
|---|---|---|
| id | uuid PK | |
| receipt_no | varchar(20) not null unique | `INV-YYYYMMDD-NNNN` |
| business_date | date not null | tanggal WIB dari `sold_at` |
| sold_at | timestamptz not null | |
| order_type | order_type not null default 'TAKE_AWAY' | |
| payment_method | payment_method not null | |
| subtotal | integer not null CHECK (subtotal >= 0) | |
| discount | integer not null default 0 CHECK (discount >= 0 AND discount <= subtotal) | |
| total | integer not null CHECK (total = subtotal - discount) | |
| cash_received | integer null | wajib ≥ total jika diisi |
| change_amount | integer null | `cash_received - total` |
| note | varchar(255) null | |
| status | sale_status not null default 'COMPLETED' | |
| void_reason | varchar(255) null | |
| voided_at | timestamptz null | CHECK: `(status='VOIDED') = (voided_at IS NOT NULL)` |
| created_at | timestamptz not null default now() | |

CHECK tambahan: `cash_received IS NULL OR (payment_method = 'CASH' AND cash_received >= total)`.
Index: `(business_date, status)`, `(sold_at DESC)`, `(payment_method)`.
Tidak ada `updated_at` karena isi penjualan immutable (R3.11); hanya kolom void yang boleh berubah, dijaga di service.

**`sale_items`** (R3.2, R3.3)

| Kolom | Tipe | Keterangan |
|---|---|---|
| id | uuid PK | |
| sale_id | uuid not null FK → sales ON DELETE RESTRICT | |
| product_id | uuid not null FK → products ON DELETE RESTRICT | menjaga R2.6 |
| product_name | varchar(100) not null | snapshot |
| category_id | uuid not null | snapshot kategori saat jual, untuk laporan per kategori |
| category_name | varchar(60) not null | snapshot |
| unit_price | integer not null CHECK (unit_price >= 0) | snapshot harga |
| qty | integer not null CHECK (qty >= 1) | |
| line_total | integer not null CHECK (line_total = unit_price * qty) | |

Index: `(sale_id)`, `(product_id)`.

**`receipt_counters`** (R3.6)

| Kolom | Tipe | Keterangan |
|---|---|---|
| business_date | date PK | |
| last_seq | integer not null | |

**`idempotency_keys`** (R3.8)

| Kolom | Tipe | Keterangan |
|---|---|---|
| key | varchar(100) PK | nilai header `Idempotency-Key` |
| request_hash | char(64) not null | SHA-256 dari body kanonik |
| sale_id | uuid not null FK → sales | |
| created_at | timestamptz not null default now() | |

**`expense_categories`** (R5.1, R5.2)

| Kolom | Tipe | Keterangan |
|---|---|---|
| id | uuid PK | |
| name | varchar(60) not null | unique index `lower(name)` |
| is_active | boolean not null default true | |
| created_at, updated_at | timestamptz | |

**`expenses`** (R5)

| Kolom | Tipe | Keterangan |
|---|---|---|
| id | uuid PK | |
| expense_date | date not null | tanggal WIB |
| category_id | uuid not null FK → expense_categories ON DELETE RESTRICT | |
| amount | integer not null CHECK (amount > 0) | |
| payment_method | payment_method not null | |
| description | varchar(255) not null | |
| vendor | varchar(100) null | pemasok/penerima |
| attachment_path | varchar(255) null | path relatif di `UPLOAD_DIR` |
| attachment_mime | varchar(50) null | |
| attachment_size | integer null | byte |
| deleted_at | timestamptz null | soft-delete (R5.6) |
| created_at, updated_at | timestamptz | |

Index parsial: `(expense_date) WHERE deleted_at IS NULL`, `(category_id) WHERE deleted_at IS NULL`.

**`audit_logs`** (R7)

| Kolom | Tipe | Keterangan |
|---|---|---|
| id | bigserial PK | urutan kronologis |
| action | varchar(50) not null | lihat daftar aksi §5.8 |
| entity_type | varchar(40) not null | `admin`, `product`, `product_category`, `sale`, `expense`, `expense_category`, `auth` |
| entity_id | varchar(64) null | |
| before | jsonb null | |
| after | jsonb null | |
| ip | inet null | |
| user_agent | varchar(255) null | |
| created_at | timestamptz not null default now() | |

Index: `(created_at DESC)`, `(entity_type, entity_id)`, `(action)`.
Append-only ditegakkan di DB: trigger `BEFORE UPDATE OR DELETE ON audit_logs` yang `RAISE EXCEPTION 'audit_logs is append-only'` (R7.3). Trigger ditulis sebagai SQL kustom di file migrasi.

### 3.3 Relasi

```
product_categories 1─* products 1─* sale_items *─1 sales 1─0..1 idempotency_keys
expense_categories 1─* expenses
admins 1─* refresh_tokens
receipt_counters, audit_logs  (mandiri)
```

## 4. Konvensi API (R8)

- Prefix bisnis `/api/v1`; `GET /health` dan `/openapi*` di root.
- Body & respons JSON `camelCase`. Nominal = integer Rupiah. Timestamp = ISO 8601 UTC (`2026-09-29T13:21:50.806Z`). Parameter tanggal `from`/`to`/`date` = `YYYY-MM-DD` (WIB), inklusif.
- Daftar: query `page` (default 1), `limit` (default 20, maks 100) → `{ data, meta: { page, limit, total, totalPages } }`.
- Error: `{ error: { code, message, details? } }`.
- Setiap route memiliki `detail: { tags, summary, security: [{ bearerAuth: [] }] }` dan skema `response` per status; skema komponen `bearerAuth` (HTTP bearer JWT) didaftarkan di plugin openapi.

### 4.1 Daftar Endpoint

| Metode & Path | Fungsi | Req |
|---|---|---|
| `GET /health` | Status app + `SELECT 1` ke DB; 200 `{status:"ok",db:"ok"}` atau 503 `{status:"degraded",db:"down"}` | R9.1 |
| `POST /api/v1/auth/login` | Login → `{ accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, admin }` | R1.3–R1.5 |
| `POST /api/v1/auth/refresh` | Rotasi token | R1.6, R1.7 |
| `POST /api/v1/auth/logout` | Body `{ refreshToken }`; revoke; 204 | R1.8 |
| `GET /api/v1/auth/me` | Profil admin | R1.11 |
| `PATCH /api/v1/auth/me` | Ubah `name`/`email` | R1.12 |
| `POST /api/v1/auth/change-password` | `{ currentPassword, newPassword }`; 204 | R1.13 |
| `GET/POST /api/v1/product-categories` | Daftar (tanpa paginasi, diurutkan `sort_order, name`) / buat | R2.1 |
| `PATCH/DELETE /api/v1/product-categories/:id` | Ubah / hapus (409 bila dipakai produk) | R2.1, R2.6 |
| `GET/POST /api/v1/products` | Daftar (filter `categoryId`, `isActive`, `q`) / buat | R2.2, R2.3, R2.7 |
| `GET/PATCH/DELETE /api/v1/products/:id` | Detail / ubah (termasuk `price`, `isActive`) / hapus (409 bila pernah dijual) | R2.4–R2.6 |
| `POST /api/v1/sales` | Buat penjualan; header opsional `Idempotency-Key` | R3.1–R3.9 |
| `GET /api/v1/sales` | Daftar (filter `from`,`to`,`paymentMethod`,`orderType`,`status`,`q`) | R3.10 |
| `GET /api/v1/sales/:id` | Detail + item | R3 |
| `POST /api/v1/sales/:id/void` | `{ reason }` | R4 |
| `GET/POST /api/v1/expense-categories` | Daftar (filter `isActive`) / buat | R5.2 |
| `PATCH/DELETE /api/v1/expense-categories/:id` | Ubah nama/`isActive` / hapus (409 bila dipakai) | R5.2 |
| `GET/POST /api/v1/expenses` | Daftar (filter `from`,`to`,`categoryId`,`paymentMethod`,`q`; `meta.totalAmount`) / buat | R5.3, R5.7 |
| `GET/PATCH/DELETE /api/v1/expenses/:id` | Detail / ubah / soft-delete (204) | R5.5, R5.6 |
| `PUT /api/v1/expenses/:id/attachment` | Upload multipart field `file` (ganti bila sudah ada) | R5.4 |
| `GET /api/v1/expenses/:id/attachment` | Unduh bukti (butuh token) | R5.4 |
| `DELETE /api/v1/expenses/:id/attachment` | Hapus bukti; 204 | R5.4 |
| `GET /api/v1/reports/summary?from&to` | Ringkasan + perbandingan periode sebelumnya | R6.1, R6.2 |
| `GET /api/v1/reports/trend?from&to&granularity=day\|month` | Deret waktu | R6.3 |
| `GET /api/v1/reports/top-products?from&to&limit` | Produk terlaris | R6.4 |
| `GET /api/v1/reports/sales-breakdown?from&to` | `{ byPaymentMethod, byOrderType, byCategory, byHour }` | R6.5 |
| `GET /api/v1/reports/expense-breakdown?from&to` | Per kategori + persentase | R6.6 |
| `GET /api/v1/reports/cash-recap?date` | Rekap kas harian | R6.7 |
| `GET /api/v1/exports/sales.csv?from&to` | CSV penjualan | R6.8 |
| `GET /api/v1/exports/sale-items.csv?from&to` | CSV item penjualan | R6.8 |
| `GET /api/v1/exports/expenses.csv?from&to` | CSV pengeluaran | R6.8 |
| `GET /api/v1/audit-logs` | Daftar (filter `from`,`to`,`action`,`entityType`,`entityId`) | R7.4 |

## 5. Desain per Modul

### 5.1 Env & Konfigurasi (R9.2)

`src/config/env.ts` mem-parsing `process.env` dengan skema TypeBox; bila gagal, cetak daftar variabel yang salah lalu `process.exit(1)`.

| Variabel | Wajib | Default | Keterangan |
|---|---|---|---|
| `NODE_ENV` | tidak | `development` | `development` \| `test` \| `production` |
| `PORT` | tidak | `3000` | |
| `DATABASE_URL` | ya | — | `postgres://...` |
| `JWT_SECRET` | ya | — | minimal 32 karakter |
| `ACCESS_TOKEN_TTL_SECONDS` | tidak | `900` | 15 menit |
| `REFRESH_TOKEN_TTL_DAYS` | tidak | `7` | |
| `CORS_ORIGINS` | ya | — | dipisah koma, mis. `http://localhost:5173` |
| `OPENAPI_ENABLED` | tidak | `true` | |
| `UPLOAD_DIR` | tidak | `./storage/uploads` | dibuat saat start bila belum ada |
| `TRUST_PROXY` | tidak | `false` | bila `true`, IP klien dari `X-Forwarded-For` paling kiri |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | hanya untuk seed | — | password min 8 karakter |

### 5.2 Waktu & Tanggal Bisnis (`lib/time.ts`)

Zona `Asia/Jakarta` tetap UTC+7 tanpa DST, sehingga konversi cukup dengan offset tetap:
- `toBusinessDate(instant: Date): string` → `YYYY-MM-DD` dari `instant + 7 jam` (UTC).
- `businessDayRangeUtc(date: string): { start: Date; end: Date }` → `[date 00:00 WIB, date+1 00:00 WIB)` dalam UTC.
- `todayBusinessDate(now = new Date())`.
- `parseDateRange(from?, to?)` → default keduanya hari ini; validasi `from <= to`, rentang ≤ 366 hari (R6.1), `to` tidak melebihi hari ini + 0 untuk laporan (tanggal masa depan diizinkan tetapi hasilnya nol — tidak ditolak).
- Periode pembanding (R6.2): panjang `n = to - from + 1` hari; `prevTo = from - 1`, `prevFrom = prevTo - n + 1`.

### 5.3 Auth (R1)

**Login**
1. Ambil IP klien (§5.9). Jika IP sedang terkunci → 429 `TOO_MANY_ATTEMPTS` dengan header `Retry-After`.
2. Cari admin berdasarkan `lower(email)`. Jika tidak ada, tetap jalankan `Bun.password.verify` terhadap hash dummy (hash tetap yang dibuat saat start) agar waktu respons setara, lalu 401 `INVALID_CREDENTIALS` "Email atau password salah".
3. Password salah → catat kegagalan di limiter, audit `auth.login_failed` (email yang dicoba disimpan di `after.email`), 401 pesan sama.
4. Sukses → reset counter IP, terbitkan token, audit `auth.login_success`.

**Penerbitan token**
- Access token: JWT HS256, claim `sub=admin.id`, `iat`, `exp=iat+ACCESS_TOKEN_TTL_SECONDS`, `iss`, `aud`, `jti`.
- Refresh token: 32 byte acak `crypto.getRandomValues` → base64url (43 karakter). Yang disimpan hanya `sha256(token)`.

**Refresh (rotasi)** dalam satu transaksi:
1. Cari baris `token_hash = sha256(input)` dengan `SELECT ... FOR UPDATE`.
2. Tidak ada / `expires_at <= now()` → 401 `INVALID_REFRESH_TOKEN`.
3. Sudah `revoked_at` → deteksi penggunaan ulang: revoke semua refresh token admin tersebut, audit `auth.refresh_reuse_detected`, 401.
4. Valid → buat token baru, set `revoked_at=now()` dan `replaced_by=<id baru>` pada baris lama, kembalikan pasangan baru.

**Logout**: revoke baris yang cocok (tidak error bila sudah revoked/tidak ditemukan — tetap 204, agar idempoten).

**Validasi token per request**: macro `auth` memverifikasi JWT lalu memeriksa `iat*1000 >= password_changed_at` (dibulatkan ke detik) sehingga access token yang terbit sebelum ganti password langsung ditolak. Data admin di-cache in-memory 30 detik per `id` untuk menghindari query di setiap request; cache dibersihkan saat profil/password berubah.

**Change password**: verifikasi `currentPassword`, validasi `newPassword` 8–72 karakter dan berbeda dari yang lama, simpan hash baru + `password_changed_at=now()`, revoke semua refresh token, audit `admin.password_changed` (tanpa isi password).

**PATCH me**: `name` 1–100 karakter, `email` format valid; audit `admin.profile_updated` dengan before/after nama & email.

**Reset password CLI** (`src/scripts/reset-password.ts`): baca password baru dari argumen `--password` atau prompt stdin (tanpa echo) bila tidak diberikan; set hash, `password_changed_at`, revoke semua refresh token, audit `admin.password_reset_cli` dengan `ip=null`.

### 5.4 Produk & Kategori Produk (R2)

- Duplikat nama kategori/SKU dideteksi dari pelanggaran unique index (`23505`) di error handler dan dipetakan ke 409 `CONFLICT` dengan pesan yang menyebut field (`"Nama kategori sudah dipakai"`, `"SKU sudah dipakai"`). Nama constraint dipetakan eksplisit ke pesan di `lib/errors.ts`.
- Hapus kategori: bila masih ada produk → 409 `CATEGORY_IN_USE` "Kategori masih dipakai produk". Hapus produk: bila ada `sale_items` merujuk → 409 `PRODUCT_IN_USE` "Produk sudah pernah dijual, nonaktifkan saja". Pengecekan eksplisit sebelum `DELETE`, dengan FK `RESTRICT` sebagai jaring pengaman (`23503` → 409 yang sama).
- Ubah harga memengaruhi `products.price` saja; penjualan lama tidak tersentuh karena memakai snapshot `sale_items.unit_price` (R2.4).
- Pencarian `q`: `name ILIKE '%q%' OR sku ILIKE '%q%'` dengan karakter `%`/`_` di-escape.
- Audit: `product_category.created|updated|deleted`, `product.created|updated|deleted`; perubahan harga tercakup di `product.updated` (before/after berisi `price`).

### 5.5 Penjualan (R3)

**Request `POST /api/v1/sales`**

```json
{
  "items": [
    { "productId": "7f3c...", "qty": 2 },
    { "productId": "a91e...", "qty": 1 }
  ],
  "paymentMethod": "CASH",
  "orderType": "TAKE_AWAY",
  "discount": 2000,
  "cashReceived": 50000,
  "note": "tanpa sambal",
  "soldAt": "2026-09-29T11:05:00.000Z"
}
```

Validasi skema: `items` 1–100 elemen, `qty` integer 1–999, `discount` integer ≥ 0, `cashReceived` integer ≥ 0 dan hanya boleh bila `paymentMethod = CASH`, `note` ≤ 255, `soldAt` opsional ISO date-time. `productId` duplikat dalam satu request digabung (qty dijumlahkan) sebelum diproses.

**Alur service `createSale`** (satu transaksi, R9.5):
1. Bila ada `Idempotency-Key` (1–100 karakter `[A-Za-z0-9_-]`): hitung `request_hash` = SHA-256 dari JSON body kanonik (key diurutkan). Cari di `idempotency_keys`:
   - ada, `created_at` < 24 jam, hash sama → kembalikan penjualan tersimpan, status 201, header `Idempotent-Replayed: true`;
   - ada, < 24 jam, hash beda → 409 `IDEMPOTENCY_KEY_REUSED`;
   - ada, ≥ 24 jam → hapus baris lama lalu lanjut sebagai baru.
2. `soldAt` > now + 60 detik (toleransi selisih jam) → 422 `SOLD_AT_IN_FUTURE`. Default `now()`.
3. Ambil semua produk `WHERE id IN (...)` join kategori. Ada yang tidak ditemukan atau `is_active = false` → 422 `PRODUCT_UNAVAILABLE` dengan `details: [{ productId, reason: "not_found" | "inactive" }]` (R3.7).
4. Hitung dengan `lib/money.ts` (fungsi murni, dites unit):
   - `lineTotal = price × qty`; `subtotal = Σ lineTotal`; `total = subtotal − discount`.
   - `discount > subtotal` → 422 `INVALID_DISCOUNT` (R3.4).
   - `CASH` dengan `cashReceived < total` → 422 `INSUFFICIENT_CASH`; `change = cashReceived − total` (R3.5). `CASH` tanpa `cashReceived` → kedua kolom `null`.
5. `businessDate = toBusinessDate(soldAt)`; nomor urut:
   ```sql
   INSERT INTO receipt_counters (business_date, last_seq) VALUES ($1, 1)
   ON CONFLICT (business_date) DO UPDATE SET last_seq = receipt_counters.last_seq + 1
   RETURNING last_seq;
   ```
   Baris counter terkunci sampai transaksi selesai sehingga permintaan bersamaan antre dan tidak ada nomor ganda (R3.6). `receiptNo = "INV-" + YYYYMMDD + "-" + pad4(seq)`; bila seq > 9999 dipakai apa adanya (5 digit) — tetap unik.
6. Insert `sales`, `sale_items` (snapshot nama, kategori, harga), `idempotency_keys` (bila ada key), audit `sale.created` (after = ringkasan: receiptNo, total, paymentMethod, jumlah item).
7. Bila dua request dengan key sama masuk bersamaan, insert kedua ke `idempotency_keys` gagal `23505`; transaksi itu di-rollback lalu service mengulang langkah 1 sekali dan mengembalikan hasil request pertama.

**Respons** (201, juga untuk detail `GET /sales/:id`):

```json
{
  "id": "…", "receiptNo": "INV-20260929-0012", "businessDate": "2026-09-29",
  "soldAt": "2026-09-29T11:05:00.000Z", "orderType": "TAKE_AWAY", "paymentMethod": "CASH",
  "subtotal": 52000, "discount": 2000, "total": 50000, "cashReceived": 50000, "changeAmount": 0,
  "note": "tanpa sambal", "status": "COMPLETED", "voidReason": null, "voidedAt": null,
  "items": [{ "productId": "…", "productName": "Paha Atas", "categoryName": "Ayam", "unitPrice": 13000, "qty": 2, "lineTotal": 26000 }],
  "createdAt": "…"
}
```

**Daftar** (R3.10): filter `from`/`to` pada `business_date`, `paymentMethod`, `orderType`, `status`, `q` (prefix/`ILIKE` pada `receipt_no`); urut `sold_at DESC, id DESC`. Item daftar tanpa `items`, dengan `itemCount`.

Tidak ada route `PATCH`/`DELETE` untuk penjualan (R3.11, R4.4).

### 5.6 Void (R4)

`POST /sales/:id/void` `{ reason: string 3–255 }`, dalam transaksi: `SELECT ... FOR UPDATE`; tidak ada → 404; `status = VOIDED` → 409 `ALREADY_VOIDED`; lainnya set `status`, `void_reason`, `voided_at=now()`, audit `sale.voided` dengan before `{status:"COMPLETED"}` dan after `{status:"VOIDED", reason}`. Semua query laporan menyaring `status = 'COMPLETED'` (R4.3).

### 5.7 Pengeluaran (R5)

- Seed kategori default (R5.1) memakai `INSERT ... ON CONFLICT DO NOTHING` sehingga aman dijalankan ulang.
- Kategori: hapus bila dipakai (termasuk pengeluaran yang sudah soft-delete) → 409 `CATEGORY_IN_USE`; nonaktifkan lewat `PATCH { isActive: false }`. Membuat/mengubah pengeluaran ke kategori nonaktif → 422 `CATEGORY_INACTIVE`.
- Create/PATCH: `expenseDate` `YYYY-MM-DD` (default hari ini WIB) dan tidak boleh > hari ini WIB → 422 `EXPENSE_DATE_IN_FUTURE`; `amount` integer 1–2.000.000.000; `description` 1–255; `vendor` ≤ 100.
- Soft-delete: set `deleted_at`; semua query daftar/detail/laporan memakai `deleted_at IS NULL`; detail pengeluaran terhapus → 404. File bukti tidak dihapus dari disk (tetap sebagai jejak).
- Daftar: `meta.totalAmount` = `SUM(amount)` dengan filter yang sama (query terpisah dari query halaman).
- Audit: `expense.created|updated|deleted`, `expense.attachment_uploaded|attachment_deleted`, `expense_category.created|updated|deleted`.

**Upload bukti** (`PUT /expenses/:id/attachment`, multipart):
- Skema Elysia `t.Object({ file: t.File({ maxSize: "5m" }) })`; ukuran > 5 MB → 422 `FILE_TOO_LARGE`.
- Tipe diverifikasi dari magic bytes (bukan hanya header klien): JPEG `FF D8 FF`, PNG `89 50 4E 47`, WEBP `RIFF....WEBP`, PDF `%PDF-`; lainnya → 422 `UNSUPPORTED_FILE_TYPE`.
- Disimpan di `UPLOAD_DIR/expenses/<expenseId>/<uuid>.<ext>` via `Bun.write`; nama file asli klien tidak dipakai di path (mencegah path traversal). Path relatif, mime, dan ukuran disimpan di baris expense; file lama tidak dihapus.
- Unduh: `GET` membaca `Bun.file(UPLOAD_DIR + path)`, header `Content-Type` dari kolom mime, `Content-Disposition: inline; filename="bukti-<expenseId>.<ext>"`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`. Tidak ada bukti → 404.

### 5.8 Riwayat Perubahan (R7)

`writeAudit(tx, { action, entityType, entityId, before, after, ctx })` dipanggil di dalam transaksi yang sama dengan perubahan datanya, sehingga audit dan data selalu konsisten (R9.5). `ctx` berisi `ip` dan `userAgent` dari request.

Redaksi: sebelum disimpan, `before`/`after` dilewatkan ke fungsi yang menghapus key `password`, `passwordHash`, `password_hash`, `currentPassword`, `newPassword`, `token`, `refreshToken`, `accessToken`, `tokenHash` di level mana pun (R7.5).

Daftar aksi: `auth.login_success`, `auth.login_failed`, `auth.refresh_reuse_detected`, `admin.profile_updated`, `admin.password_changed`, `admin.password_reset_cli`, `product_category.created|updated|deleted`, `product.created|updated|deleted`, `sale.created`, `sale.voided`, `expense_category.created|updated|deleted`, `expense.created|updated|deleted|attachment_uploaded|attachment_deleted`.

`GET /audit-logs`: filter `from`/`to` (dikonversi ke rentang UTC via `businessDayRangeUtc`), `action`, `entityType`, `entityId`; urut `id DESC`. Tidak ada route tulis (R7.3), dan trigger DB menolak UPDATE/DELETE.

### 5.9 Rate Limit Login (R1.5)

`lib/rate-limit.ts`: `Map<ip, { failures: number[]; lockedUntil?: number }>` in-memory. Pada kegagalan, simpan timestamp dan buang yang lebih tua dari 15 menit; bila ≥ 5 → `lockedUntil = now + 15 menit`. Login sukses menghapus entri. Pembersihan entri kedaluwarsa setiap 5 menit via `setInterval(...).unref()`.

Konsekuensi yang diterima: penghitung hilang saat restart dan tidak dibagi antar instance. Ini sesuai untuk deployment satu instance; bila nanti dijalankan multi-instance, limiter perlu dipindah ke tabel PostgreSQL.

IP klien: `server.requestIP(request).address`; bila `TRUST_PROXY=true`, pakai entri paling kiri `X-Forwarded-For`.

### 5.10 Laporan (R6)

Semua query laporan: `sales.status = 'COMPLETED'`, `expenses.deleted_at IS NULL`, filter tanggal pada `business_date` / `expense_date` (memakai index). Semua `SUM` di-`COALESCE(..., 0)` dan di-cast `::bigint`, lalu dikonversi `Number()` di service.

- **Summary** (R6.1, R6.2): satu query agregat `sales` (`SUM(subtotal)`, `SUM(discount)`, `SUM(total)`, `COUNT(*)`) + satu query `SUM(amount)` expenses, dijalankan untuk periode sekarang dan periode pembanding (4 query, paralel dengan `Promise.all`). `averageTicket = count > 0 ? Math.round(netSales / count) : 0`; `netProfit = netSales − expenses`. Perbandingan per metrik: `{ current, previous, change, changePct }` dengan `changePct = previous === 0 ? null : round2((current − previous) / |previous| × 100)`.
- **Trend** (R6.3): `generate_series(from, to, '1 day')` (atau `date_trunc('month', ...)` dengan langkah `'1 month'` untuk `granularity=month`) di-`LEFT JOIN` ke agregat penjualan dan pengeluaran per bucket, sehingga bucket kosong bernilai 0. Output `[{ period: "2026-09-01", netSales, expenses, netProfit }]`; untuk bulan `period` = tanggal pertama bulan.
- **Top products** (R6.4): `GROUP BY sale_items.product_id, product_name` terbaru — nama yang ditampilkan diambil dari `products.name` saat ini (join) agar produk yang diganti nama tidak terpecah; `ORDER BY SUM(qty) DESC, SUM(line_total) DESC LIMIT n`.
- **Sales breakdown** (R6.5): `byPaymentMethod` dan `byOrderType` dari `sales`; `byCategory` dari `sale_items` grup `category_id` (snapshot) — `transactionCount` = `COUNT(DISTINCT sale_id)`, omzet = `SUM(line_total)`; `byHour` dari `EXTRACT(HOUR FROM sold_at AT TIME ZONE 'Asia/Jakarta')`, diisi 24 bucket 0–23 di service. Semua nilai enum selalu muncul walau 0.
  Catatan konsistensi: omzet per kategori dihitung dari `line_total` (sebelum diskon transaksi), sedangkan per metode bayar/tipe pesanan dari `total` (setelah diskon). Respons memberi field `basis: "gross"` untuk `byCategory` dan `basis: "net"` untuk lainnya supaya frontend tidak salah menjumlahkan (R6.9).
- **Expense breakdown** (R6.6): `GROUP BY category_id`; `percentage = round2(amount / total × 100)`, 0 bila total 0.
- **Cash recap** (R6.7): untuk `date` tunggal — `cashSales = SUM(total) WHERE payment_method='CASH'`, `cashExpenses = SUM(amount) WHERE payment_method='CASH'`, `cashNet = cashSales − cashExpenses`, `nonCashSales = { QRIS, TRANSFER, EWALLET }`, `nonCashExpenses` per metode yang sama.
- **Validasi**: `from > to` → 422 `INVALID_DATE_RANGE`; rentang > 366 hari → 422 `DATE_RANGE_TOO_LARGE`; `limit` top products 1–50.

### 5.11 Ekspor CSV (R6.8)

Respons `text/csv; charset=utf-8` dengan BOM UTF-8 (agar Excel membaca karakter Indonesia dengan benar), `Content-Disposition: attachment; filename="sales_<from>_<to>.csv"`. Dialirkan sebagai `ReadableStream`, membaca DB per batch 1.000 baris (keyset pagination pada `(sold_at, id)`), sehingga memori tetap kecil. Nilai di-escape sesuai RFC 4180 (kutip ganda bila mengandung koma, kutip, atau newline); nilai yang diawali `=`, `+`, `-`, `@` diberi prefiks `'` untuk mencegah CSV injection. Rentang maks 366 hari.

| File | Kolom |
|---|---|
| `sales.csv` | `receipt_no, business_date, sold_at_wib, order_type, payment_method, subtotal, discount, total, cash_received, change_amount, status, void_reason, note` |
| `sale-items.csv` | `receipt_no, business_date, product_name, category_name, unit_price, qty, line_total, sale_status` |
| `expenses.csv` | `expense_date, category, description, vendor, payment_method, amount, has_attachment` |

`sold_at_wib` berformat `YYYY-MM-DD HH:mm:ss` waktu WIB. Pengeluaran yang dihapus tidak disertakan; penjualan VOIDED disertakan dengan kolom status agar rekonsiliasi lengkap. Kolom didokumentasikan di `detail.description` route OpenAPI.

## 6. Penanganan Error (R8.5, R8.6)

`AppError(status, code, message, details?)` dilempar dari service. Error handler global memetakan:

| Sumber | HTTP | `code` |
|---|---|---|
| Validasi TypeBox Elysia (`VALIDATION`) | 422 | `VALIDATION_ERROR`, `details: [{ field, message }]` dari `error.all` |
| Body JSON rusak (`PARSE`) | 422 | `INVALID_BODY` |
| Route tidak ada (`NOT_FOUND`) | 404 | `NOT_FOUND` |
| `AppError` | sesuai | sesuai |
| PostgreSQL `23505` (unique) | 409 | `CONFLICT` + pesan dari peta nama constraint |
| PostgreSQL `23503` (FK) | 409 | `IN_USE` |
| PostgreSQL `23514` (check) | 422 | `INVALID_VALUE` |
| Lainnya | 500 | `INTERNAL_ERROR`, pesan "Terjadi kesalahan pada server" |

Error 500 dicatat lengkap (stack, `requestId`) di log server, tetapi respons hanya berisi pesan generik dan `requestId` di header `X-Request-Id` (R8.5). Pesan error berbahasa Indonesia; `code` stabil berbahasa Inggris untuk dipakai frontend. Semua respons error mendapat skema OpenAPI `ErrorResponse` bersama.

## 7. Keamanan

- Semua endpoint bisnis butuh access token (R1.9); `/health` hanya mengungkap status ok/down.
- Password argon2id; secret JWT ≥ 32 karakter; refresh token disimpan sebagai hash; deteksi reuse refresh token.
- Validasi input di setiap route (TypeBox), query parameterisasi via Drizzle, escape wildcard `ILIKE`.
- Upload: batas ukuran, verifikasi magic bytes, path dibangkitkan server, unduh butuh auth, `nosniff`.
- CORS allowlist; header keamanan ditambahkan di `onAfterHandle`: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
- Log dan audit tidak pernah memuat password/token (R7.5, R9.7).
- API ini dirancang berjalan di balik HTTPS (reverse proxy/platform hosting); aplikasi sendiri mendengarkan HTTP di `PORT`.

## 8. Performa (R9.6)

- Pembuatan penjualan: ±6 query dalam satu transaksi, semua lewat PK/unique index → jauh di bawah 300 ms.
- Summary 31 hari / 30.000 transaksi: agregat memakai index `(business_date, status)`; sekitar 1.000 baris/hari, tanpa join ke `sale_items`. Breakdown kategori dan top products men-join `sale_items` via `(sale_id)`.
- Pool koneksi postgres.js `max: 10`.
- Test performa: skrip `tests/perf/seed-30k.ts` mengisi 30.000 penjualan acak dalam 31 hari, lalu `tests/perf/reports.perf.test.ts` mengukur 50 panggilan summary dan memastikan p95 < 1 detik; dijalankan manual (`bun run test:perf`), tidak masuk `bun test` default.

## 9. Strategi Test (R9.8)

- **Unit** (`tests/unit`, tanpa DB): `money.ts` (subtotal, diskon batas, kembalian, kas kurang), `time.ts` (batas tengah malam WIB: `2026-09-29T16:59:59Z` → 29 Sep, `17:00:00Z` → 30 Sep; periode pembanding), `csv.ts` (escape & anti-injection), `rate-limit.ts` (5 gagal → kunci, kedaluwarsa 15 menit dengan jam palsu), redaksi audit.
- **Integrasi** (`tests/integration`): `createApp({ db })` + `app.handle(new Request(...))` terhadap DB uji `TEST_DATABASE_URL` (container postgres di port 5433). `tests/setup.ts` (preload via `bunfig.toml`) menjalankan migrasi sekali lalu `TRUNCATE ... RESTART IDENTITY CASCADE` sebelum setiap file test (tabel `audit_logs` dikecualikan dari trigger dengan `TRUNCATE`, yang tidak memicu trigger baris). Cakupan:
  - auth: login sukses/gagal, pesan generik, 429 setelah 5 gagal, rotasi & reuse refresh, logout, ganti password membatalkan token lama, setiap route `/api/v1` tanpa token → 401 (diiterasi dari daftar route app);
  - sales: perhitungan & snapshot harga, produk nonaktif → 422 tanpa data tersimpan, idempotensi (replay & key dipakai ulang beda body), 20 request paralel → 20 nomor struk unik berurutan, void & laporan mengabaikan VOIDED;
  - expenses: validasi tanggal, soft-delete, upload tipe/ukuran salah, unduh butuh token;
  - reports: fixture kecil dengan angka yang dihitung manual untuk summary, perbandingan, trend (bucket kosong = 0), breakdown, cash recap; konsistensi agregat vs jumlah baris mentah;
  - audit: entri tercipta untuk aksi utama, tanpa field sensitif, UPDATE langsung ke `audit_logs` ditolak DB.
- Script: `bun test` (unit + integrasi), `bun run test:unit`, `bun run test:perf`.

## 10. Operasional

- `docker-compose.yml`: service `db` (postgres:16-alpine, port 5432, volume `pgdata`) dan `db-test` (port 5433, tmpfs, tanpa volume).
- Script `package.json`: `dev`, `start` (`bun src/index.ts`), `db:generate` (`drizzle-kit generate`), `db:migrate` (`bun src/db/migrate.ts`), `db:seed`, `admin:reset-password`, `test`, `test:unit`, `test:perf`, `typecheck` (`tsc --noEmit`).
- Startup: `loadEnv` → cek koneksi DB (gagal → exit 1 dengan pesan jelas) → buat `UPLOAD_DIR` → `listen`. Migrasi **tidak** dijalankan otomatis saat start; dijalankan eksplisit via `db:migrate` agar deploy terkontrol.
- Graceful shutdown: pada `SIGTERM`/`SIGINT`, `app.stop()` lalu tutup pool DB.
- README diperbarui: prasyarat (Bun, Docker), salin `.env.example`, `docker compose up -d`, `bun install`, `bun run db:migrate`, `bun run db:seed`, `bun run dev`, buka `http://localhost:3000/openapi`.
- Backup: di luar cakupan kode, tetapi README mencantumkan contoh `pg_dump` harian dan catatan bahwa `UPLOAD_DIR` harus ikut dibackup.

## 11. Pemetaan Requirement → Desain

| Requirement | Bagian desain |
|---|---|
| R1 Akun Admin & Autentikasi | §3.2 `admins`, `refresh_tokens`; §5.3; §5.9; §7 |
| R2 Produk & Kategori | §3.2 `product_categories`, `products`; §5.4 |
| R3 Penjualan | §3.2 `sales`, `sale_items`, `receipt_counters`, `idempotency_keys`; §5.5 |
| R4 Void | §5.6 |
| R5 Pengeluaran | §3.2 `expense_categories`, `expenses`; §5.7 |
| R6 Dashboard & Laporan | §5.10; §5.11 |
| R7 Riwayat Perubahan | §3.2 `audit_logs`; §5.8 |
| R8 Kontrak API & OpenAPI | §2.2; §4; §6 |
| R9 Operasional & Non-fungsional | §5.1; §8; §9; §10 |
