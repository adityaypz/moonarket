// src/payment/tripay.js
import crypto from 'crypto';
import axios from 'axios';

const BASE = process.env.TRIPAY_BASE_URL || 'https://tripay.co.id';
const API  = process.env.TRIPAY_API_KEY_PUBLIC;
const PRIV = process.env.TRIPAY_API_KEY_PRIVATE;
const MC   = process.env.TRIPAY_MERCHANT_CODE;

const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('hex');

export async function createTransaction({ orderId, amount, customer, items, callbackUrl, returnUrl, method = 'QRIS' }) {
  const signature = hmac(PRIV, MC + orderId + amount);
  const payload = {
    method,
    merchant_ref: orderId,
    amount,
    customer_name: customer.name,
    customer_email: customer.email,
    order_items: items?.length ? items : [{ sku: orderId, name: 'Order', price: amount, quantity: 1 }],
    callback_url: callbackUrl,
    return_url: returnUrl,
    expired_time: Math.floor(Date.now() / 1000) + 60 * 30,
    signature
  };
  const { data } = await axios.post(`${BASE}/api/transaction/create`, payload, {
    headers: { Authorization: `Bearer ${API}` }
  });
  return {
    ok: true,
    checkoutUrl: data?.data?.checkout_url,
    reference:   data?.data?.reference,
    qrUrl:       data?.data?.qr_url,
    qrString:    data?.data?.qr_string
  };
}

export function verifyWebhook(rawBody, headerSig) {
  return hmac(PRIV, rawBody) === headerSig;
}

export function parseWebhook(body) {
  // normalisasi ke bentuk umum
  return {
    provider: 'tripay',
    orderId: body?.merchant_ref,
    reference: body?.reference,
    status: String(body?.status || '').toUpperCase(), // PAID | UNPAID | EXPIRED | REFUND | CANCEL
    amount: body?.amount ?? 0
  };
}

export const isPaid = (status) => status === 'PAID';
