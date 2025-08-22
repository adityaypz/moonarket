# 📦 Telegram Marketplace Bot
Bot marketplace digital product dengan integrasi pembayaran **Tripay** (tested) & **Midtrans (opsional)**.  
Fitur utama: auto-generate order, pembayaran via Tripay, auto-delivery produk setelah pembayaran sukses, riwayat transaksi, dan kontrol admin.  

---

## ✨ Features
- ✅ Integrasi **Tripay Payment Gateway** (QRIS, e-wallet, bank transfer).  
- ✅ **Auto Delivery Produk Digital** setelah payment sukses.  
- ✅ **Riwayat Transaksi** (status: FAILED / PENDING / FULFILLED).  
- ✅ **Produk Populer** & **List Produk** dengan pagination.  
- ✅ **Admin Menu** → toggle produk aktif/nonaktif, lihat info produk.  
- ✅ **Webhook** Tripay & Midtrans dengan response 200 OK.  
- ✅ Database **SQLite + Prisma** (portable & mudah).  
- ✅ Deploy di VPS dengan **domain + SSL (HTTPS)**.  

---

## 🛠️ Tech Stack
- Node.js (Express.js, Telegraf)  
- Prisma ORM (SQLite)  
- Tripay API  
- Midtrans API (opsional)  
- VPS (Ubuntu recommended)  

---

## 🚀 Installation & Setup

### 1. Clone Project
```bash
git clone https://github.com/adityaypz/moonarket
cd moonarket
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Setup Environment
Buat file `.env`:
```env
# TELEGRAM
TELEGRAM_BOT_TOKEN=
PUBLIC_BASE_URL=webmu    # tanpa trailing slash

# PILIH GATEWAY (tripay | midtrans)
PAYMENT_PROVIDER=tripay

# TRIPAY
TRIPAY_API_KEY_PUBLIC=
TRIPAY_API_KEY_PRIVATE=
TRIPAY_MERCHANT_CODE=
TRIPAY_BASE_URL=https://www.tripay.co.id/api

# MIDTRANS (isi kalau mau pakai midtrans)
MIDTRANS_SERVER_KEY=
MIDTRANS_CLIENT_KEY=
MIDTRANS_IS_PRODUCTION=false
MIDTRANS_QRIS_ACQUIRER=gopay

# DATABASE
DATABASE_URL="file:./dev.db"

# ADMIN ID'S (boleh banyak, pisah koma)
ADMIN_IDS=
```

### 4. Database Setup (Prisma + SQLite)
```bash
npx prisma generate
npx prisma migrate dev --name init
```

### 5. Run Bot (Dev Mode)
```bash
npm run dev
```

### 6. Run Bot (Production)
```bash
npm start
```

---

## 🔗 Webhook Setup
Tambahkan ke `.env` → otomatis terdaftar:
- `https://domain.com/payment/webhook` (generic)  
- `https://domain.com/tripay/webhook` (Tripay)  
- `https://domain.com/midtrans/webhook` (Midtrans, opsional)  

---

## 📊 Admin Panel (via Telegram)
- `/start` → Menu utama.  
- `List Produk` → tampilkan semua produk.  
- `Produk Populer` → produk highlight.  
- `Riwayat Transaksi` → semua transaksi user.  
- **Admin button**:  
  - Toggle produk aktif/nonaktif.  
  - Lihat info produk.  

---

## 📂 Project Structure
```
src/
 ├── index.js          # Main bot & server
 ├── payment/          # Tripay & Midtrans integration
 ├── prisma/           # Prisma schema & migrations
 ├── utils.js          # Helper functions
 └── logger.js         # Logging
```

---

## 🛍️ How It Works (Flow)
1. User pilih produk → bot generate order ID.  
2. User bayar via Tripay → webhook terima notifikasi.  
3. Bot update status order (FAILED / PENDING / FULFILLED).  
4. Jika sukses → produk digital dikirim otomatis via Telegram.  
5. User bisa cek riwayat transaksi kapanpun.  

---

## 👩‍💻 Useful Commands
- Jalankan Prisma Studio (lihat database di VPS):  
  ```bash
  npx prisma studio
  ```
  *(gunakan SSH tunnel jika akses dari lokal)*  

- Cek database SQLite langsung:  
  ```bash
  sqlite3 ./prisma/dev.db
  .tables
  SELECT * FROM Product;
  ```

---

## 🧭 Roadmap (Next Features)
- [ ] Auto-generate produk populer dari penjualan.  
- [ ] Kategori produk (Netflix, Spotify, Canva, dll).  
- [ ] Voucher / kode diskon.  
- [ ] Laporan admin (total penjualan harian/mingguan).  

---

## ⚡ Credits
Dibuat oleh **Moonarket Team** dengan ❤️  
Integrasi: [Tripay](https://tripay.co.id) | [Midtrans](https://midtrans.com)  
