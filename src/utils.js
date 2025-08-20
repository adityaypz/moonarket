import crypto from 'crypto';

export const genOrderId = (prefix = 'ORDER') =>
  `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

export function formatIDR(n) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(n);
}
