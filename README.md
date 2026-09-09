# Panduan Operasional Portal Pengadaan BNU

## 1. Latar Belakang

Portal Pengadaan BNU merupakan aplikasi berbasis web yang dirancang untuk mendukung proses lelang atau bidding pengadaan secara digital. Aplikasi ini memungkinkan Panitia Pengadaan dan peserta/vendor melakukan proses penawaran secara terstruktur, terukur, dan terdokumentasi dalam satu sistem.

Portal ini dibuat untuk memfasilitasi kegiatan pengadaan yang melibatkan beberapa peserta dengan mekanisme ronde bidding, evaluasi merit point, serta pengambilan keputusan yang lebih objektif berdasarkan hasil penawaran dan teknik evaluasi yang telah ditentukan.

## 2. Tujuan

Aplikasi ini bertujuan untuk:

- mempermudah Panitia Pengadaan dalam mengelola sesi bidding;
- menyediakan akses digital untuk vendor dalam mengirim penawaran;
- menjaga transparansi proses tender melalui log dan rekam jejak penawaran;
- menghitung hasil evaluasi secara otomatis berdasarkan skor teknis dan harga;
- memudahkan pengambilan keputusan akhir dengan rekapan hasil yang tersusun.

## 3. Peran Pengguna

### 3.1 Panitia Pengadaan
Panitia bertanggung jawab untuk:

- membuat sesi pengadaan baru;
- menetapkan durasi ronde bidding;
- menentukan HPS dan nilai wajar;
- membuka dan menutup ronde;
- memantau peringkat live;
- menyelesaikan sesi dan menampilkan hasil akhir.

### 3.2 Vendor / Peserta
Vendor memiliki akses untuk:

- masuk ke portal menggunakan kode sesi dan token akses;
- melihat informasi sesi dan status ronde;
- mengirim penawaran harga sesuai aturan yang berlaku;
- memantau posisi sementara dan status penawaran mereka.

## 4. Struktur Aplikasi

Aplikasi terdiri atas beberapa komponen utama:

- `server.js` — server Node.js utama yang menangani routing, logika bidding, dan API.
- `panitia.html` — halaman antarmuka Panitia Pengadaan.
- `vendor.html` — halaman antarmuka peserta/vendor.
- `render.yaml` — konfigurasi deployment di Render.
- `Dockerfile` — konfigurasi containerisasi untuk deployment.
- `package.json` — metadata aplikasi dan perintah eksekusi.

## 5. Persyaratan Sistem

Sebelum menjalankan portal, pastikan perangkat sudah memenuhi persyaratan berikut:

- Node.js versi 18 atau yang lebih baru
- npm
- Browser modern (Chrome, Edge, Firefox, atau Safari terbaru)
- Akses internet jika akan digunakan dari perangkat berbeda lokasi

## 6. Cara Menjalankan Aplikasi Secara Lokal

### 6.1 Unduh / Salin Project

Pastikan project tersedia di folder kerja Anda.

### 6.2 Instal Dependensi

Buka terminal pada folder project dan jalankan perintah berikut:

```bash
npm install
```

### 6.3 Jalankan Server

```bash
npm start
```

Secara default server akan berjalan pada port 8080. Setelah server aktif, akses URL berikut pada browser:

- Panitia: http://localhost:8080/panitia
- Vendor: http://localhost:8080/vendor

Jika diperlukan, jalankan dengan port lain seperti berikut:

```bash
PORT=9000 npm start
```

## 7. Prosedur Operasional Panitia

### 7.1 Membuat Sesi Baru

1. Buka halaman Panitia.
2. Isi form pendaftaran sesi pengadaan, meliputi:
   - judul pengadaan;
   - deskripsi pengadaan;
   - daftar vendor;
   - durasi setiap ronde;
   - HPS atau pagu harga;
   - nilai wajar (opsional);
   - pengaturan tampilan HPS dan teknis untuk vendor.
3. Klik tombol "Mulai Sesi Bidding".

Sistem akan otomatis membuat:

- kode sesi;
- token admin;
- link akses vendor tertentu untuk masing-masing peserta.

### 7.2 Membagikan Akses ke Vendor

Setelah sesi dibuat, Panitia dapat menyalin link vendor yang tersedia dan membagikannya kepada peserta sesuai dengan identitas masing-masing. Link tersebut berisi kode sesi dan token akses vendor untuk masuk ke portal.

### 7.3 Membuka dan Menutup Ronde

Panitia dapat melakukan tindakan berikut:

- klik "Buka Ronde Baru" untuk memulai ronde bidding;
- menunggu vendor mengirimkan penawaran;
- menutup ronde secara manual apabila diperlukan;
- menutup semua ronde secara otomatis ketika batas waktu tercapai.

### 7.4 Memantau Hasil Live

Saat ronde berlangsung, halaman Panitia menampilkan:

- status ronde aktif atau tertutup;
- countdown waktu;
- leaderboard live;
- data harga terkini setiap vendor;
- log perubahan harga dan unggul sementara;
- status pemenuhan HPS dan nilai wajar.

### 7.5 Menyelesaikan Sesi

Setelah semua ronde selesai, Panitia dapat menekan tombol "Selesaikan Sesi & Tampilkan Hasil". Sistem akan menampilkan:

- hasil akhir perhitungan merit point;
- peringkat vendor;
- status pemenuhan HPS;
- ringkasan hasil akhir;
- riwayat unggul per ronde.

## 8. Prosedur Operasional Vendor

### 8.1 Masuk ke Portal

1. Buka link vendor yang diterima dari Panitia.
2. Masukkan kode sesi dan token akses.
3. Klik tombol "Masuk".

### 8.2 Mengirim Penawaran

1. Pastikan ronde aktif telah dibuka oleh Panitia.
2. Masukkan harga penawaran dalam format rupiah.
3. Klik tombol "Kirim".

Aturan penting:

- harga harus lebih rendah dari penawaran sebelumnya;
- harga yang dikirim harus valid dan lebih besar dari 0;
- sistem akan menolak pengiriman jika penawaran tidak memenuhi kriteria.

### 8.3 Melihat Status

Vendor dapat memantau:

- apakah ronde sedang aktif;
- jumlah waktu yang tersisa;
- status unggul sementara;
- harga terakhir yang dikirim;
- riwayat penawaran sebelumnya.

## 9. Mekanisme Penilaian

Portal menggunakan pendekatan merit point yang menggabungkan dua komponen utama, yaitu:

- skor teknis;
- skor harga.

Total skor akhir dihitung berdasarkan penawaran yang masuk dan ketentuan yang berlaku. Harga juga diperiksa terhadap HPS dan nilai wajar untuk menentukan apakah penawaran memenuhi syarat. Vendor dengan total merit point tertinggi dapat menjadi kandidat unggulan, namun tetap harus memenuhi syarat harga agar dapat dinyatakan layak.

## 10. Aturan Penting Dalam Proses Bidding

Beberapa ketentuan yang harus dipatuhi:

- minimal terdapat dua vendor dalam satu sesi;
- HPS wajib diisi dan harus bernilai positif;
- nilai wajar bersifat opsional, tetapi jika diisi harus valid;
- harga harus terus menurun dari penawaran sebelumnya;
- log bid dicatat untuk kebutuhan audit dan berita acara.

## 11. Manajemen Data

Portal ini menggunakan penyimpanan data in-memory di server. Artinya:

- data sesi akan hilang ketika server di-restart;
- aplikasi cocok untuk simulasi, pelatihan, atau kebutuhan operasional internal;
- untuk penggunaan produksi jangka panjang, disarankan penggunaan database permanen dan sistem autentikasi yang lebih aman.

## 12. Deployment

### 12.1 Deploy ke Render

Project sudah dilengkapi konfigurasi `render.yaml` untuk deployment otomatis pada Render.

Langkah umum:

1. Push repository ke GitHub.
2. Buat proyek baru di Render.
3. Hubungkan repository yang sesuai.
4. Render akan membaca file konfigurasi dan menjalankan aplikasi.
5. Server akan siap menerima akses publik.

### 12.2 Deploy dengan Docker

Container image juga tersedia melalui `Dockerfile`.

Contoh build dan run:

```bash
docker build -t pengadaan-bnu .
docker run -p 8080:8080 pengadaan-bnu
```

## 13. Endpoint Utama

Aplikasi ini menyediakan API sederhana untuk kebutuhan operasional, di antaranya:

- `POST /api/sessions` — membuat sesi baru
- `GET /api/sessions/:code/admin?adminToken=...` — membuka panel admin
- `POST /api/sessions/:code/admin/round/open` — membuka ronde
- `POST /api/sessions/:code/admin/round/close` — menutup ronde
- `POST /api/sessions/:code/admin/finish` — menyelesaikan sesi
- `GET /api/sessions/:code/vendor?token=...` — melihat panel vendor
- `POST /api/sessions/:code/vendor/bid` — mengirim penawaran

## 14. Troubleshooting

### 14.1 Server Tidak Dapat Dibuka

Pastikan:

- Node.js terpasang dengan benar;
- dependency sudah diinstall;
- port 8080 tidak sedang dipakai aplikasi lain.

### 14.2 Vendor Tidak Dapat Masuk

Pastikan:

- kode sesi benar;
- token akses sesuai dengan data yang diberikan Panitia;
- server masih berjalan dan tidak mengalami restart.

### 14.3 Penawaran Tidak Terrecord

Pastikan:

- ronde aktif sudah dibuka;
- harga yang dimasukkan lebih rendah dari penawaran sebelumnya;
- format angka valid dan nilainya positif.

## 15. Kesimpulan

Portal Pengadaan BNU dirancang sebagai alat pendukung proses pengadaan yang lebih cepat, transparan, dan terstruktur. Dengan sistem bidding digital, Panitia Pengadaan dapat mengelola sesi dengan lebih efisien, sementara peserta dapat mengikuti proses secara lebih terukur dan akuntabel.

Dokumen ini menjadi acuan operasional utama dalam penggunaan portal. Untuk kebutuhan produksi yang lebih kompleks, diperlukan pengembangan lanjutan seperti penyimpanan data permanen, autentikasi yang aman, notifikasi real-time, dan ekspor hasil ke format laporan formal.
