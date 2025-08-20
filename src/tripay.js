// src/tripay.js
import crypto from 'crypto';
import axios from 'axios';

const BASE_URL = process.env.TRIPAY_BASE_URL || 'https://tripay.co.id';
const API_KEY   = process.env.TRIPAY_API_KEY_PUBLIC;   // "Bearer <API KEY>"
const PRIV_KEY  = process.env.TRIPAY_API_KEY_PRIVATE;  // untuk signature
const MERCHANT  = process.env.TRIPAY_MERCHANT_CODE;

function hmacSha256(key, msg) {
  return crypto.createHmac('sha256', key).update(msg).digest('hex');
}

/**
 * Create transaction (close payment) di Tripay
 * @param {Object} p
 *  - method: contoh 'QRIS'
 *  - merchant_ref: string unik orderId
 *  - amount: number (IDR)
 *  - customer_name, customer_email
 *  - items: [{ sku, name, price, quantity }]
 *  - callback_url, return_url, expired_time (unix detik)
 */
export async function tripayCreateTransaction(p) {
  const url = `${BASE_URL}/api/transaction/create`;
  const signature = hmacSha256(
    PRIV_KEY,
    MERCHANT + p.merchant_ref + p.amount
  );

  const payload = {
    method: p.method, // ex: 'QRIS','BRIVA','MANDIRIVA','PERMATAVA', dll
    merchant_ref: p.merchant_ref,
    amount: p.amount,
    customer_name: p.customer_name,
    customer_email: p.customer_email,
    order_items: p.items?.length ? p.items : [
      { sku: p.merchant_ref, name: 'Order', price: p.amount, quantity: 1 }
    ],
    callback_url: p.callback_url,
    return_url: p.return_url,
    expired_time: p.expired_time || Math.floor(Date.now()/1000) + 60*30, // 30m
    signature
  };

  const resp = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${API_KEY}` }
  });

  // data. checkout_url, reference, instructions, (untuk QRIS kadang ada qr_url)
  return resp.data?.data;
}

/** Verifikasi callback Tripay: HMAC-SHA256(rawBody, PRIVATE_KEY) */
export function verifyTripayCallbackSignature(rawBody, headerSig) {
  const expected = hmacSha256(PRIV_KEY, rawBody);
  return expected === headerSig;
}
