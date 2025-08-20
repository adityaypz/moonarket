// src/payment/tripay.js
import crypto from 'crypto';
import axios from 'axios';

const BASE = process.env.TRIPAY_BASE_URL || 'https://tripay.co.id';
const API  = process.env.TRIPAY_API_KEY_PUBLIC;
const PRIV = process.env.TRIPAY_API_KEY_PRIVATE;
const MC   = process.env.TRIPAY_MERCHANT_CODE;
const METHOD_DEFAULT = process.env.TRIPAY_DEFAULT_METHOD || 'QRIS';

const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('hex');
const api = axios.create({
  baseURL: BASE,
  headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
  timeout: 15000
});

/**
 * Create Tripay transaction (invoice)
 */
export async function createTransaction({ orderId, amount, customer, items, callbackUrl, returnUrl, method = METHOD_DEFAULT }) {
  const signature = hmac(PRIV, MC + orderId + amount);
  const payload = {
    method,
    merchant_ref: orderId,
    amount,
    customer_name: customer?.name || 'Telegram User',
    customer_email: customer?.email || 'user@telegram.local',
    customer_phone: customer?.phone || '-',
    order_items: (items || []).map(it => ({
      sku: it.sku || it.id || 'item',
      name: it.name || 'Item',
      price: it.price || amount,
      quantity: it.quantity || 1,
      product_url: it.url || undefined
    })),
    callback_url: callbackUrl,
    return_url: returnUrl,
    expired_time: Math.floor(Date.now() / 1000) + 60 * 60 // 1 jam
  };

  const { data } = await api.post('/api/transaction/create', payload, {
    headers: {
      'Authorization': 'Bearer ' + API,
      'X-Signature': signature,
      'X-Merchant-Code': MC
    }
  });

  const d = data?.data || {};
  return {
    reference: d.reference,
    checkoutUrl: d.checkout_url || d.pay_url || d.payment_url || null,
    // for QRIS, Tripay often provides QR content/url in detail endpoint;
    // we keep createQris() below to fetch it.
  };
}

/**
 * Create QRIS quickly (Tripay)
 * Some Tripay channels return a QR content in the detail endpoint.
 */
export async function createQris({ orderId, amount }) {
  // Ensure there's a transaction first
  const tx = await createTransaction({
    orderId,
    amount,
    customer: { name: 'Telegram User', email: 'user@telegram.local' },
    items: [{ name: 'Digital Item', price: amount, quantity: 1 }],
    callbackUrl: process.env.PUBLIC_BASE_URL + '/payment/webhook',
    returnUrl: process.env.PUBLIC_BASE_URL + '/thanks?o=' + orderId,
    method: 'QRIS'
  });

  // Try to fetch detail to get QR content/url
  try {
    const { data } = await api.get('/api/transaction/detail', {
      params: { reference: tx.reference },
      headers: { 'Authorization': 'Bearer ' + API }
    });
    const d = data?.data || {};
    // Try common fields
    const qrString = d.qr_string || d.qris_content || null;
    const qrUrl = d.qr_url || d.qris_url || d.qr_code_url || null;
    return { qrString, qrUrl, reference: tx.reference };
  } catch {
    // fallback: just give checkout url (the pay page usually renders QR)
    return { qrString: null, qrUrl: tx.checkoutUrl, reference: tx.reference };
  }
}

/**
 * Verify Tripay webhook HMAC
 * header: X-Callback-Signature = HMAC_SHA256(rawBody, PRIV)
 */
export function verifyWebhook(rawBody, signatureHeader) {
  try {
    const expected = hmac(PRIV, rawBody || '');
    return String(signatureHeader || '') === expected;
  } catch {
    return false;
  }
}

/**
 * Normalize Tripay webhook body
 */
export function parseWebhook(body) {
  return {
    provider: 'tripay',
    orderId: body?.merchant_ref,
    reference: body?.reference,
    status: String(body?.status || '').toUpperCase(), // PAID | UNPAID | EXPIRED | REFUND | CANCEL
    amount: body?.amount ?? 0
  };
}

/**
 * Paid checker
 */
export const isPaid = (status) => String(status).toUpperCase() === 'PAID';

/**
 * Optional wrapper to align with index.js usage
 */
export async function createPayLink(params) {
  const r = await createTransaction(params);
  return { checkoutUrl: r.checkoutUrl, reference: r.reference };
}
