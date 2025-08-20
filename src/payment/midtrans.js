// src/payment/midtrans.js
import { createSnapTransaction, chargeQris, verifyMidtransSignature, isPaidStatus } from '../midtrans.js';

export async function createTransaction({ orderId, amount, customer, items, callbackUrl, returnUrl, method }) {
  // midtrans gak butuh method. gunakan Snap.
  const snap = await createSnapTransaction({
    orderId,
    grossAmount: amount,
    customer: {
      first_name: customer?.name?.split(' ')[0] || 'User',
      last_name:  customer?.name?.split(' ').slice(1).join(' ') || '',
      email: customer?.email || 'user@telegram.local'
    }
  });
  return {
    ok: true,
    checkoutUrl: snap?.redirect_url,
    reference: orderId, // midtrans pakai orderId
    qrUrl: null,
    qrString: null
  };
}

export async function createQris({ orderId, amount }) {
  const res = await chargeQris({ orderId, grossAmount: amount });
  return { qrUrl: res?.qr_url, qrString: res?.qr_string };
}

export function verifyWebhook(rawBody, _header) {
  // midtrans verifikasi pakai body (order_id, status_code, gross_amount + server key) — sudah di file kamu
  try { return verifyMidtransSignature(JSON.parse(rawBody)); } catch { return false; }
}

export function parseWebhook(body) {
  const status = String(body?.transaction_status || '').toLowerCase(); // e.g. 'settlement'
  return {
    provider: 'midtrans',
    orderId: body?.order_id,
    reference: body?.order_id,
    status, // biarkan lower; diputuskan oleh isPaid()
    amount: Number(body?.gross_amount || 0)
  };
}

export const isPaid = (status) => isPaidStatus(String(status).toLowerCase());
