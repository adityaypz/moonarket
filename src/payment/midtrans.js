// src/payment/midtrans.js
import {
  chargeQris,
  createSnapTransaction,
  verifyMidtransSignature,
  isPaidStatus
} from '../midtrans.js';

/**
 * Create a pay link (Snap redirect_url)
 */
export async function createPayLink({ orderId, amount, customer }) {
  const name = String(customer?.name || '').trim();
  const [first_name, ...rest] = name.split(/\s+/);
  const last_name = rest.join(' ') || 'User';

  const { token, redirect_url } = await createSnapTransaction({
    orderId,
    grossAmount: amount,
    customer: {
      first_name: first_name || 'Telegram',
      last_name,
      email: customer?.email || 'user@telegram.local'
    }
  });
  return { token, checkoutUrl: redirect_url };
}

/**
 * Create QRIS (Core API)
 */
export async function createQris({ orderId, amount }) {
  const { qr_string, qr_url } = await chargeQris({ orderId, grossAmount: amount });
  return { qrString: qr_string || null, qrUrl: qr_url || null };
}

/**
 * Verify Midtrans webhook signature
 * Midtrans signature is sent in the JSON body; no header required.
 */
export function verifyWebhook(rawBody /* string */, _sigHeader /* ignored */) {
  try {
    const body = JSON.parse(rawBody || '{}');
    return verifyMidtransSignature(body);
  } catch {
    return false;
  }
}

/**
 * Normalize Midtrans webhook body
 */
export function parseWebhook(body) {
  return {
    provider: 'midtrans',
    orderId: body?.order_id,
    reference: body?.transaction_id || body?.order_id,
    status: String(body?.transaction_status || '').toLowerCase(),
    amount: Number(body?.gross_amount || 0)
  };
}

/**
 * Paid checker
 */
export const isPaid = (status) => isPaidStatus(status);
