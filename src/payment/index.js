// src/payment/index.js
import * as Tripay from './tripay.js';
import * as Mid from './midtrans.js';

const PROVIDER = (process.env.PAYMENT_PROVIDER || 'tripay').toLowerCase();

export async function createPayLink(params) {
  if (PROVIDER === 'midtrans') return Mid.createPayLink(params);
  // default Tripay
  if (typeof Tripay.createPayLink === 'function') return Tripay.createPayLink(params);
  // backward compatibility if adapter exposes createTransaction
  const r = await Tripay.createTransaction(params);
  return { checkoutUrl: r.checkoutUrl, reference: r.reference };
}

export async function createQris({ orderId, amount }) {
  if (PROVIDER === 'midtrans') return Mid.createQris({ orderId, amount });
  return Tripay.createQris({ orderId, amount });
}

export const tripay = {
  verifyWebhook: Tripay.verifyWebhook,
  parseWebhook: Tripay.parseWebhook,
  isPaid: Tripay.isPaid,
};

export const midtrans = {
  verifyWebhook: Mid.verifyWebhook,
  parseWebhook: Mid.parseWebhook,
  isPaid: Mid.isPaid,
};
