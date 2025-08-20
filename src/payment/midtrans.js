import axios from 'axios';
import crypto from 'crypto';
import { error } from './logger.js';

const { MIDTRANS_SERVER_KEY, MIDTRANS_IS_PRODUCTION = 'false', PUBLIC_BASE_URL } = process.env;
const isProd = MIDTRANS_IS_PRODUCTION === 'true';
const baseURL = isProd ? 'https://app.midtrans.com/snap/v1' : 'https://app.sandbox.midtrans.com/snap/v1';

const coreBaseURL = isProd
  ? 'https://api.midtrans.com'
  : 'https://api.sandbox.midtrans.com';

const core = axios.create({
  baseURL: coreBaseURL,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    Authorization: 'Basic ' + Buffer.from(MIDTRANS_SERVER_KEY + ':').toString('base64')
  },
  timeout: 15000
});

/**
 * Buat charge QRIS (Core API) lalu kembalikan qr_string untuk dirender jadi QR image
 * @param {{orderId:string, grossAmount:number}} p
 * @returns {Promise<{qr_string:string}>}
 */
export async function chargeQris({ orderId, grossAmount }) {
  const body = {
    payment_type: 'qris',
    transaction_details: { order_id: orderId, gross_amount: grossAmount },
    qris: { acquirer: process.env.MIDTRANS_QRIS_ACQUIRER || 'gopay' }
  };

  try {
    const { data } = await core.post('/v2/charge', body);

    // --- ekstrak semua kemungkinan ---
    const qr_string = data?.qris?.qr_string || data?.qr_string || null;

    let qr_url = null;
    if (Array.isArray(data?.actions)) {
      const a = data.actions.find(x =>
        /qr|generate-qr-code/i.test(String(x?.name || '')) && x?.url
      );
      if (a) qr_url = a.url;
    }
    // beberapa akun memberi 'qr_url' / 'qr_code_url' langsung
    if (!qr_url) qr_url = data?.qr_url || data?.qr_code_url || null;

    if (!qr_string && !qr_url) {
      // log mentah biar keliatan respon real dari Midtrans
      console.error('Midtrans QRIS raw response:', JSON.stringify(data));
      throw new Error('QRIS created but no qr_string or QR url in actions');
    }
    return { qr_string, qr_url };
  } catch (e) {
    const info = e.response?.data || { message: e.message };
    console.error('Midtrans QRIS error:', info);
    throw new Error(JSON.stringify(info));
  }
}
/**
 * Cek status transaksi (Core API)
 * @param {string} orderId
 */
export async function getTransactionStatus(orderId) {
  const { data } = await core.get(`/v2/${orderId}/status`);
  return data; // ada fields transaction_status, status_code, gross_amount, dll
}
const http = axios.create({
  baseURL,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    Authorization: 'Basic ' + Buffer.from(MIDTRANS_SERVER_KEY + ':').toString('base64')
  },
  timeout: 15000
});

export async function createSnapTransaction({ orderId, grossAmount, customer }) {
  const body = {
    transaction_details: { order_id: orderId, gross_amount: grossAmount },
    customer_details: {
      first_name: customer?.first_name || 'Telegram',
      last_name: customer?.last_name || 'User',
      email: customer?.email || 'user@example.com'
    },
    callbacks: { finish: `${PUBLIC_BASE_URL}/thanks` },
    item_details: [{ id: orderId, price: grossAmount, quantity: 1, name: 'Digital Item' }],
    credit_card: { secure: true }
  };

  const { data } = await http.post('/transactions', body);
  return { token: data.token, redirect_url: data.redirect_url };
}

export function verifyMidtransSignature(notificationBody) {
  try {
    const serverKey = MIDTRANS_SERVER_KEY;
    const { order_id, status_code, gross_amount, signature_key } = notificationBody;
    const input = order_id + status_code + gross_amount + serverKey;
    const localSig = crypto.createHash('sha512').update(input).digest('hex');
    return localSig === signature_key;
  } catch (e) {
    error('verifyMidtransSignature error', e.message);
    return false;
  }
}

export function isPaidStatus(s) {
  return ['capture', 'settlement', 'success'].includes(String(s || '').toLowerCase());
}
