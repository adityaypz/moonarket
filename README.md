# Telegram Marketplace Bot (Midtrans + Prisma + Ngrok)

> **Note (SQLite)**: Prisma enum tidak dipakai agar kompatibel penuh di SQLite. Status order disimpan sebagai `String`.
> Jika pindah ke Postgres/MySQL, boleh ubah ke `enum`.

## Quickstart
1) `npm install`
2) Copy `.env.example` -> `.env`
3) `npm run prisma:gen && npm run prisma:push && npm run seed`
4) `npm run dev`
5) Jalankan `ngrok http 3000` dan set `PUBLIC_BASE_URL` ke URL tsb.
6) Midtrans "Payment Notification URL" -> `https://xxxx.ngrok-free.app/midtrans/webhook`
