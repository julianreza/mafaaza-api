# Requirements — Admin Dashboard API Toko Fried Chicken (mafaaza-api)

## Pendahuluan

Pemilik toko fried chicken membutuhkan backend admin dashboard untuk mencatat penjualan, pengeluaran, dan melihat ringkasan keuangan harian/bulanan. Dokumen ini mendefinisikan perilaku yang terlihat oleh admin dari REST API `mafaaza-api`, yang akan dikonsumsi oleh frontend dashboard terpisah.

Tech stack yang ditetapkan: Bun + Elysia, dokumentasi OpenAPI, PostgreSQL, Drizzle ORM. Repo saat ini masih template `bun create elysia` (hanya `GET /` "Hello Elysia"), sehingga fitur ini dibangun greenfield.

### Asumsi cakupan

- MVP berisi: Autentikasi, Produk (menu), Penjualan, Pengeluaran, Laporan/Dashboard ringkasan, Riwayat perubahan (audit).
- **Satu akun admin tanpa peran** (keputusan user): tidak ada manajemen pengguna maupun otorisasi per peran; siapa pun yang login sebagai admin memiliki akses penuh.
- Satu outlet (belum multi-cabang). Stok bahan baku (inventori) di luar MVP.
- Penjualan dicatat per transaksi dengan rincian item (produk × qty).
- Mata uang tunggal Rupiah (IDR), nominal bilangan bulat tanpa desimal. Zona waktu bisnis `Asia/Jakarta` (WIB).
- Bahasa pesan error API: Indonesia.

### Glosarium

- **Admin**: satu-satunya akun pengguna sistem (pemilik toko), akses penuh.
- **Produk**: item menu yang dijual (mis. "Paha Atas", "Paket Nasi + Dada", "Es Teh").
- **Kategori Produk**: pengelompokan menu (mis. Ayam, Paket, Minuman, Tambahan).
- **Penjualan (Sale)**: satu transaksi pembelian pelanggan, berisi satu atau lebih item.
- **Pengeluaran (Expense)**: uang keluar operasional (bahan baku, gas, gaji, sewa, listrik, dll).
- **Kategori Pengeluaran**: pengelompokan pengeluaran.
- **Metode Pembayaran**: `CASH`, `QRIS`, `TRANSFER`, `EWALLET`.
- **Tipe Pesanan**: `TAKE_AWAY` (beli di toko, dibawa pulang) atau `ONLINE` (pesanan lewat aplikasi/online). Toko tidak melayani makan di tempat.
- **Void**: pembatalan transaksi yang sudah tercatat; data tidak dihapus, hanya ditandai batal.
- **Hari bisnis**: tanggal kalender dalam WIB (00:00–23:59 Asia/Jakarta).

---

## Requirement 1 — Akun Admin & Autentikasi

**User story:** Sebagai admin, saya ingin login dengan email dan password agar hanya saya yang dapat mengakses data toko.

### Acceptance Criteria

1. WHEN aplikasi pertama kali disiapkan THEN sistem SHALL menyediakan perintah seed yang membuat akun admin dari variabel lingkungan (`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`); IF akun admin sudah ada THEN seed SHALL tidak membuat akun kedua dan tidak menimpa password yang ada.
2. Sistem SHALL tidak menyediakan endpoint pendaftaran atau pembuatan pengguna baru.
3. WHEN admin mengirim email dan password yang benar ke endpoint login THEN sistem SHALL mengembalikan access token (berlaku 15 menit) dan refresh token (berlaku 7 hari), beserta profil admin (id, nama, email).
4. WHEN email tidak cocok atau password salah THEN sistem SHALL mengembalikan HTTP 401 dengan pesan generik "Email atau password salah" tanpa membedakan penyebabnya.
5. WHEN terjadi 5 kali gagal login dari alamat IP yang sama dalam 15 menit THEN sistem SHALL menolak percobaan berikutnya dari IP tersebut dengan HTTP 429 selama 15 menit.
6. WHEN refresh token valid dikirim ke endpoint refresh THEN sistem SHALL menerbitkan pasangan token baru dan membatalkan refresh token lama (rotasi).
7. WHEN refresh token yang sudah dibatalkan atau kedaluwarsa dipakai THEN sistem SHALL mengembalikan HTTP 401.
8. WHEN admin logout THEN sistem SHALL membatalkan refresh token sesi tersebut.
9. WHEN permintaan ke endpoint terproteksi tidak membawa access token valid THEN sistem SHALL mengembalikan HTTP 401. Semua endpoint di bawah `/api/v1` SHALL terproteksi kecuali login dan refresh.
10. Sistem SHALL menyimpan password hanya dalam bentuk hash (argon2id), tidak pernah plaintext, dan tidak pernah mengembalikan hash di respons API.
11. WHEN admin meminta endpoint profil THEN sistem SHALL mengembalikan nama dan email admin.
12. WHEN admin mengubah nama atau email profil THEN sistem SHALL menyimpannya; email SHALL divalidasi formatnya.
13. WHEN admin mengganti password dengan menyertakan password lama yang benar dan password baru minimal 8 karakter THEN sistem SHALL memperbarui password dan membatalkan semua refresh token (keluar dari semua perangkat).
14. WHEN admin lupa password THEN pemulihan SHALL dilakukan lewat perintah CLI server `bun run admin:reset-password` yang menetapkan password baru dan membatalkan semua refresh token; tidak ada alur reset via email.

## Requirement 2 — Kategori Produk & Produk (Menu)

**User story:** Sebagai admin, saya ingin mengelola daftar menu beserta harganya agar pencatatan penjualan cepat dan konsisten.

### Acceptance Criteria

1. WHEN admin membuat kategori produk dengan nama unik THEN sistem SHALL menyimpannya; nama duplikat (case-insensitive) SHALL ditolak HTTP 409.
2. WHEN admin membuat produk dengan nama, kategori, harga jual (bilangan bulat ≥ 0), dan opsional SKU serta deskripsi THEN sistem SHALL menyimpannya dengan status aktif.
3. IF SKU diisi dan sudah dipakai produk lain THEN sistem SHALL menolak dengan HTTP 409.
4. WHEN admin mengubah harga produk THEN sistem SHALL menerapkan harga baru untuk penjualan berikutnya tanpa mengubah harga yang tercatat di penjualan sebelumnya.
5. WHEN admin menonaktifkan produk THEN produk SHALL tidak dapat dipilih pada penjualan baru namun tetap tampil pada riwayat dan laporan.
6. IF admin mencoba menghapus produk atau kategori yang sudah pernah dipakai di penjualan THEN sistem SHALL menolak dengan HTTP 409 dan menyarankan menonaktifkan.
7. WHEN admin meminta daftar produk THEN sistem SHALL mendukung filter kategori, status aktif, pencarian nama/SKU, dan paginasi.

## Requirement 3 — Pencatatan Penjualan

**User story:** Sebagai admin, saya ingin mencatat setiap transaksi pelanggan dengan rincian item dan metode bayar agar omzet toko tercatat akurat.

### Acceptance Criteria

1. WHEN admin membuat penjualan dengan minimal satu item (produk aktif, qty bilangan bulat ≥ 1), metode pembayaran, dan opsional diskon, catatan, serta tipe pesanan (`TAKE_AWAY` atau `ONLINE`; default `TAKE_AWAY` — toko tidak melayani makan di tempat) THEN sistem SHALL menyimpan transaksi dan mengembalikan HTTP 201 berisi detail lengkap.
2. Sistem SHALL mengambil harga satuan dari data produk saat transaksi dibuat (bukan dari klien) dan menyimpannya sebagai snapshot beserta nama produk.
3. Sistem SHALL menghitung: subtotal item = harga satuan × qty; subtotal = jumlah subtotal item; total = subtotal − diskon.
4. IF diskon negatif atau melebihi subtotal THEN sistem SHALL menolak dengan HTTP 422.
5. WHEN metode pembayaran `CASH` dan nominal diterima dikirim THEN sistem SHALL menyimpan nominal diterima dan kembalian; IF nominal diterima lebih kecil dari total THEN sistem SHALL menolak dengan HTTP 422.
6. Sistem SHALL memberi setiap penjualan nomor struk unik berformat `INV-YYYYMMDD-NNNN` dengan urutan yang di-reset per hari bisnis WIB, tanpa duplikat meski ada permintaan bersamaan.
7. IF item memuat produk nonaktif atau tidak ada THEN sistem SHALL menolak seluruh transaksi dengan HTTP 422 dan tidak menyimpan sebagian.
8. WHEN klien mengirim header `Idempotency-Key` yang sama dua kali dalam 24 jam THEN sistem SHALL mengembalikan penjualan yang sama tanpa membuat transaksi kedua.
9. Sistem SHALL mencatat waktu transaksi (disimpan UTC, di-bucket ke hari/jam berdasarkan WIB). WHEN admin mengisi `soldAt` (untuk input susulan) THEN nilainya SHALL tidak boleh di masa depan; default adalah waktu server saat ini.
10. WHEN admin meminta daftar penjualan THEN sistem SHALL mendukung filter rentang tanggal, metode pembayaran, tipe pesanan, status (`COMPLETED`/`VOIDED`), pencarian nomor struk, dan paginasi, diurutkan terbaru lebih dulu.
11. Penjualan yang sudah tersimpan SHALL tidak dapat diubah isinya; koreksi dilakukan dengan void lalu mencatat transaksi baru.

## Requirement 4 — Void Penjualan

**User story:** Sebagai admin, saya ingin membatalkan transaksi yang salah input tanpa menghapus jejaknya agar laporan akurat dan bisa ditelusuri.

### Acceptance Criteria

1. WHEN admin mem-void penjualan berstatus `COMPLETED` dengan alasan (wajib, 3–255 karakter) THEN sistem SHALL mengubah status menjadi `VOIDED` serta menyimpan alasan dan waktu void.
2. IF penjualan sudah `VOIDED` THEN sistem SHALL menolak dengan HTTP 409.
3. Penjualan `VOIDED` SHALL tidak dihitung dalam omzet, laporan, dan dashboard, namun tetap tampil di riwayat dengan status jelas.
4. Sistem SHALL tidak menyediakan endpoint untuk menghapus penjualan secara permanen.

## Requirement 5 — Kategori Pengeluaran & Pencatatan Pengeluaran

**User story:** Sebagai admin, saya ingin mencatat semua pengeluaran operasional agar saya tahu ke mana uang toko keluar dan berapa laba bersihnya.

### Acceptance Criteria

1. WHEN seed dijalankan THEN sistem SHALL membuat kategori pengeluaran default: Bahan Baku Ayam, Tepung & Bumbu, Minyak Goreng, Gas/LPG, Kemasan, Gaji Karyawan, Sewa Tempat, Listrik & Air, Transportasi, Perawatan & Perbaikan, Lain-lain.
2. WHEN admin menambah, mengganti nama, atau menonaktifkan kategori pengeluaran THEN sistem SHALL menyimpannya; nama duplikat (case-insensitive) SHALL ditolak HTTP 409; kategori yang sudah dipakai SHALL hanya bisa dinonaktifkan, tidak dihapus.
3. WHEN admin mencatat pengeluaran dengan tanggal (default hari ini WIB, tidak boleh di masa depan), kategori aktif, nominal (bilangan bulat > 0), metode pembayaran, deskripsi, dan opsional nama pemasok/penerima THEN sistem SHALL menyimpannya dan mengembalikan HTTP 201.
4. WHEN admin mengunggah foto/PDF bukti (nota) maks 5 MB berformat JPEG, PNG, WEBP, atau PDF THEN sistem SHALL menyimpannya dan menautkannya ke pengeluaran; format atau ukuran lain SHALL ditolak HTTP 422. File bukti SHALL hanya dapat diunduh dengan access token valid.
5. WHEN admin mengubah pengeluaran THEN sistem SHALL menyimpan perubahan dan mencatatnya di riwayat perubahan.
6. WHEN admin menghapus pengeluaran THEN sistem SHALL melakukan soft-delete (data tidak lagi tampil di daftar dan laporan, namun tetap ada di database dan riwayat perubahan).
7. WHEN admin meminta daftar pengeluaran THEN sistem SHALL mendukung filter rentang tanggal, kategori, metode pembayaran, pencarian deskripsi/pemasok, dan paginasi, beserta total nominal hasil filter.

## Requirement 6 — Dashboard & Laporan

**User story:** Sebagai admin, saya ingin melihat ringkasan penjualan, pengeluaran, dan laba agar dapat mengambil keputusan bisnis dengan cepat.

### Acceptance Criteria

1. WHEN admin meminta ringkasan untuk rentang tanggal (default hari ini WIB, maksimal 366 hari) THEN sistem SHALL mengembalikan: omzet kotor (subtotal), total diskon, omzet bersih (total), jumlah transaksi, rata-rata nilai transaksi, total pengeluaran, dan laba bersih (omzet bersih − pengeluaran), hanya dari penjualan `COMPLETED` dan pengeluaran yang tidak dihapus.
2. WHEN admin meminta ringkasan THEN sistem SHALL juga mengembalikan perbandingan dengan periode sebelumnya yang sama panjang (nilai dan persentase perubahan; `null` bila periode sebelumnya bernilai nol).
3. WHEN admin meminta tren THEN sistem SHALL mengembalikan deret omzet bersih, pengeluaran, dan laba per hari (atau per bulan bila `granularity=month`) dalam rentang tanggal, termasuk hari/bulan bernilai nol.
4. WHEN admin meminta produk terlaris THEN sistem SHALL mengembalikan N produk teratas (default 10, maks 50) berdasarkan qty terjual beserta omzetnya.
5. WHEN admin meminta rincian penjualan per metode pembayaran, per tipe pesanan, per kategori produk, dan per jam (0–23 WIB) THEN sistem SHALL mengembalikan jumlah transaksi dan omzet untuk masing-masing.
6. WHEN admin meminta rincian pengeluaran per kategori THEN sistem SHALL mengembalikan total dan persentase tiap kategori.
7. WHEN admin meminta rekap kas harian untuk satu tanggal THEN sistem SHALL mengembalikan penerimaan tunai, pengeluaran tunai, dan selisih kas, serta total non-tunai per metode.
8. WHEN admin meminta ekspor CSV penjualan, item penjualan, atau pengeluaran untuk rentang tanggal THEN sistem SHALL mengembalikan file CSV (UTF-8, pemisah koma) dengan kolom yang terdokumentasi di OpenAPI.
9. Semua angka agregat SHALL konsisten dengan data transaksi mentah pada filter yang sama (tanpa selisih pembulatan, karena seluruh nominal bilangan bulat).

## Requirement 7 — Riwayat Perubahan (Audit)

**User story:** Sebagai admin, saya ingin melihat apa yang berubah dan kapan agar dapat menelusuri salah input atau akses yang mencurigakan.

### Acceptance Criteria

1. Sistem SHALL mencatat riwayat untuk: login berhasil/gagal, perubahan profil dan password admin, perubahan produk & harga, pembuatan dan void penjualan, pembuatan/perubahan/penghapusan pengeluaran, serta perubahan kategori.
2. Setiap entri SHALL memuat aksi, jenis dan id entitas, data sebelum dan sesudah (untuk perubahan), alamat IP, user agent, dan waktu.
3. Riwayat SHALL bersifat append-only; tidak ada endpoint untuk mengubah atau menghapusnya.
4. WHEN admin meminta riwayat THEN sistem SHALL mendukung filter rentang tanggal, aksi, jenis entitas, id entitas, dan paginasi.
5. Sistem SHALL tidak pernah mencatat password, hash password, atau token di riwayat.

## Requirement 8 — Kontrak API & Dokumentasi OpenAPI

**User story:** Sebagai developer frontend, saya ingin kontrak API yang jelas dan terdokumentasi agar integrasi dashboard cepat dan minim salah paham.

### Acceptance Criteria

1. Sistem SHALL menyajikan spesifikasi OpenAPI 3 di `/openapi/json` dan UI dokumentasi interaktif di `/openapi`, dengan setiap endpoint punya skema request, respons, contoh, tag domain, dan kebutuhan autentikasi.
2. WHEN `OPENAPI_ENABLED=false` THEN kedua endpoint dokumentasi SHALL mengembalikan HTTP 404.
3. Semua endpoint bisnis SHALL berada di bawah prefix `/api/v1`.
4. Respons sukses daftar SHALL berbentuk `{ data: [...], meta: { page, limit, total, totalPages } }`; `limit` default 20, maksimal 100.
5. Respons error SHALL berbentuk `{ error: { code, message, details? } }` dengan kode HTTP yang tepat: 401, 404, 409, 422, 429, 500. Error 500 SHALL tidak membocorkan stack trace atau detail SQL.
6. WHEN input tidak lolos validasi skema THEN sistem SHALL mengembalikan HTTP 422 dengan `details` berisi daftar field yang salah beserta alasannya.
7. Semua nominal uang SHALL dikirim dan diterima sebagai bilangan bulat Rupiah; semua timestamp dalam ISO 8601 UTC; parameter tanggal filter berformat `YYYY-MM-DD` dan ditafsirkan sebagai hari bisnis WIB.

## Requirement 9 — Operasional & Kualitas Non-fungsional

**User story:** Sebagai pemilik sistem, saya ingin API aman, andal, dan mudah dijalankan agar dashboard dapat dipakai setiap hari tanpa gangguan.

### Acceptance Criteria

1. Sistem SHALL menyediakan endpoint `GET /health` (tanpa auth) yang mengembalikan status aplikasi dan konektivitas database.
2. Sistem SHALL membaca seluruh konfigurasi (URL database, secret JWT, CORS origin, port, direktori upload, dll) dari variabel lingkungan yang divalidasi saat start; IF variabel wajib hilang atau tidak valid THEN aplikasi SHALL gagal start dengan pesan jelas.
3. Sistem SHALL hanya menerima permintaan CORS dari origin yang terdaftar di `CORS_ORIGINS`.
4. Skema database SHALL dikelola lewat migrasi Drizzle yang berversi dan dapat dijalankan dengan satu perintah.
5. Operasi yang menulis lebih dari satu tabel (mis. penjualan + item + riwayat) SHALL atomik: seluruhnya berhasil atau seluruhnya dibatalkan.
6. Endpoint pembuatan penjualan SHALL merespons dalam p95 < 300 ms dan endpoint ringkasan dashboard untuk rentang 31 hari dengan 30.000 transaksi SHALL merespons dalam p95 < 1 detik pada lingkungan pengembangan standar.
7. Sistem SHALL menulis log terstruktur (JSON) per permintaan berisi request id, metode, path, status, dan durasi, tanpa memuat password atau token.
8. Proyek SHALL memiliki test otomatis (`bun test`) yang mencakup aturan perhitungan penjualan, proteksi autentikasi endpoint, dan agregasi laporan, serta dapat dijalankan terhadap database PostgreSQL uji.
9. Proyek SHALL menyediakan `docker-compose` untuk PostgreSQL lokal dan README berisi langkah setup, migrasi, seed, dan menjalankan aplikasi.

---

## Di Luar Cakupan (MVP)

- Frontend dashboard (dibangun terpisah; spec ini hanya API).
- Multi-pengguna, peran, dan hak akses per peran (mis. akun kasir terpisah).
- Reset password via email.
- Inventori/stok bahan baku, resep, dan HPP per produk.
- Multi-cabang/outlet.
- Varian & add-on produk (mis. level pedas, extra sambal) sebagai entitas terpisah — sementara dimodelkan sebagai produk tersendiri.
- Integrasi payment gateway, printer struk, dan ojek online (GoFood/GrabFood).
- Program loyalti/member pelanggan.
- Pajak (PPN/PB1) dan service charge.
