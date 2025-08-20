// src/payment/tripay.js (updated for Sandbox/Production auto-paths)
import crypto from 'crypto';
import axios from 'axios';

const BASE = (process.env.TRIPAY_BASE_URL || 'https://www.tripay.co.id').replace(/\/$/, '');
const API_KEY  = process.env.TRIPAY_API_KEY_PUBLIC;
const PRIV_KEY = process.env.TRIPAY_API_KEY_PRIVATE;
const MERCHANT = process.env.TRIPAY_MERCHANT_CODE;
const DEFAULT_METHOD = process.env.TRIPAY_DEFAULT_METHOD || 'QRIS';

// Detect if BASE already contains /api or /api-sandbox
const hasApiSuffix = /(\/api(?:-sandbox)?)$/.test(BASE);

/**
 * Build endpoint path safely for both sandbox & production.
 * If BASE ends with /api-sandbox or /api, we just append '/{segment}'
 * Otherwise, we prepend '/api' (production) by default.
 */
function ep(segment) {
  segment = segment.replace(/^\//, ''); // trim leading slash
  if (hasApiSuffix) return '/' + segment;                 // e.g., https://.../api-sandbox + /transaction/create
  return '/api/' + segment;                                // e.g., https://... + /api/transaction/create
}

function hmac(key, msg) {
  return crypto.createHmac('sha256', key).update(msg).digest('hex');
}

const api = axios.create({
  baseURL: BASE,
  headers: { 'Accept': 'application/json' },
  timeout: 20000
});

/**
 * Create Tripay transaction (invoice)
 * Docs: POST {base}/api(-sandbox)/transaction/create
 * Auth: Authorization: Bearer {API_KEY}
 * Body: method, merchant_ref, amount, customer_name/email, order_items[], callback_url, return_url, expired_time, signature(hmac(PRIV, MERCHANT+merchant_ref+amount))
 */
export async function createTransaction({ orderId, amount, customer, items, callbackUrl, returnUrl, method = DEFAULT_METHOD, expiredSeconds = 60 * 60 }) {
  if (!API_KEY || !PRIV_KEY || !MERCHANT) throw new Error('Tripay env missing: TRIPAY_API_KEY_PUBLIC/TRIPAY_API_KEY_PRIVATE/TRIPAY_MERCHANT_CODE');
  const merchant_ref = orderId;
  const signature = hmac(PRIV_KEY, MERCHANT + merchant_ref + amount);

  const payload = {
    method,
    merchant_ref,
    amount,
    customer_name: customer?.name || 'Telegram User',
    customer_email: customer?.email || 'user@telegram.local',
    customer_phone: customer?.phone || undefined,
    order_items: (items || []).map(it => ({
      sku: it.sku || it.id || 'item',
      name: it.name || 'Item',
      price: it.price || amount,
      quantity: it.quantity || 1,
      product_url: it.url || undefined,
      image_url: it.image_url || undefined
    })),
    callback_url: callbackUrl,
    return_url: returnUrl,
    expired_time: Math.floor(Date.now() / 1000) + expiredSeconds,
    signature
  };

  // Send as form-urlencoded (per docs examples)
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || v === null) continue;
    if (k === 'order_items' && Array.isArray(v)) {
      let i = 0;
      for (const it of v) {
        for (const [ik, iv] of Object.entries(it)) {
          if (iv === undefined) continue;
          form.append(`order_items[${i}][${ik}]`, String(iv));
        }
        i++;
      }
    } else {
      form.append(k, String(v));
    }
  }

  const { data } = await api.post(ep('transaction/create'), form, {
    headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    validateStatus: s => s < 999
  });

  if (!data || data.success === false) {
    throw new Error(data?.message || 'Tripay createTransaction failed');
  }
  const d = data.data || {};
  return {
    reference: d.reference,
    checkoutUrl: d.checkout_url || d.pay_url || d.payment_url || null,
  };
}

/**
 * Create QRIS quickly (Tripay): we create invoice with method=QRIS, then fetch detail to get QR content/url
 * Docs: GET {base}/api(-sandbox)/transaction/detail?reference=...
 */
export async function createQris({ orderId, amount }) {
  const tx = await createTransaction({
    orderId,
    amount,
    customer: { name: 'Telegram User', email: 'user@telegram.local' },
    items: [{ name: 'Digital Item', price: amount, quantity: 1 }],
    callbackUrl: (process.env.PUBLIC_BASE_URL || '') + '/payment/webhook',
    returnUrl: (process.env.PUBLIC_BASE_URL || '') + '/thanks?o=' + orderId,
    method: 'QRIS'
  });

  try {
    const { data } = await api.get(ep('transaction/detail'), {
      params: { reference: tx.reference },
      headers: { 'Authorization': 'Bearer ' + API_KEY },
      validateStatus: s => s < 999
    });
    const d = data?.data || {};
    const qrString = d.qr_string || d.qris_content || null;
    const qrUrl = d.qr_url || d.qris_url || d.qr_code_url || null;
    return { qrString, qrUrl, reference: tx.reference };
  } catch {
    return { qrString: null, qrUrl: tx.checkoutUrl, reference: tx.reference };
  }
}

/**
 * Verify Tripay webhook HMAC
 * header: X-Callback-Signature = HMAC_SHA256(rawBody, PRIV_KEY)
 */
export function verifyWebhook(rawBody, signatureHeader) {
  try {
    const expected = hmac(PRIV_KEY, rawBody || '');
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
    amount: Number(body?.amount || 0)
  };
}

/**
 * Paid checker
 */
export const isPaid = (status) => String(status).toUpperCase() === 'PAID';

/**
 * Wrapper to align with payment/index.js usage
 */
export async function createPayLink(params) {
  const r = await createTransaction(params);
  return { checkoutUrl: r.checkoutUrl, reference: r.reference };
}
