// src/payment/index.js
import * as tri from './tripay.js';
import * as mid from './midtrans.js';

const PROVIDER = (process.env.PAYMENT_PROVIDER || 'tripay').toLowerCase();

export function active() {
  return PROVIDER === 'midtrans' ? mid : tri;
}

// — Helpers untuk index.js (agar kode bersih) —
export async function createPayLink({ orderId, amount, customer, items, callbackUrl, returnUrl, method }) {
  return active().createTransaction({ orderId, amount, customer, items, callbackUrl, returnUrl, method });
}
export async function createQris({ orderId, amount }) {
  // midtrans punya create qris; tripay juga; fallback: createTransaction dan pakai qrUrl/qrString
  if (active() === mid) return mid.createQris({ orderId, amount });
  const t = await tri.createTransaction({ orderId, amount, method: 'QRIS' });
  return { qrUrl: t.qrUrl, qrString: t.qrString };
}

// Verifier khusus webhook (biar bisa dua endpoint aktif bersamaan)
export const tripay = tri;
export const midtrans = mid;
