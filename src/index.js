import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import { Telegraf, Markup } from 'telegraf';
import { PrismaClient } from '@prisma/client';
import { log, error } from './logger.js';
import { genOrderId, formatIDR } from './utils.js';
import QRCode from 'qrcode';
import { chargeQris, getTransactionStatus, createSnapTransaction, verifyMidtransSignature, isPaidStatus } from './midtrans.js';

// --- Admin helpers ---
const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isAdminCtx(ctx) {
  const id = ctx?.from?.id ? String(ctx.from.id) : '';
  return ADMIN_IDS.includes(id);
}
// === Throttle helper (anti spam callback) ===
const cbqRate = new Map(); // userId -> timestamp ms

function shouldThrottle(id, ms = 2000) {
  const now = Date.now();
  const last = cbqRate.get(id) || 0;
  if (now - last < ms) return true;
  cbqRate.set(id, now);
  return false;
}

// optional: bersihkan entri lama biar nggak numpuk
setInterval(() => {
  const cutoff = Date.now() - 60_000; // 1 menit
  for (const [id, t] of cbqRate) if (t < cutoff) cbqRate.delete(id);
}, 60_000);
// === Mini session untuk wizard admin ===
const adminSessions = new Map(); // key: telegramId(string) -> {step, data}

function getSess(ctx) {
  const id = String(ctx.from?.id || '');
  if (!adminSessions.has(id)) adminSessions.set(id, { step: null, data: {} });
  return adminSessions.get(id);
}
function clearSess(ctx) {
  const id = String(ctx.from?.id || '');
  adminSessions.delete(id);
}
// middleware guard sederhana
function requireAdmin(handler) {
  return async (ctx, ...args) => {
    if (!isAdminCtx(ctx)) {
      return ctx.reply('❌ Akses ditolak. Fitur ini hanya untuk admin.');
    }
    return handler(ctx, ...args);
  };
}
// Escape HTML utk teks dinamis
const esc = (s = '') =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
// --- [PATCH] pagination & format ringkas ---
const PAGE_SIZE = 6; // 5–8 enak; aku set 6 biar rapi grid

function shortIDR(n) {
  return `Rp ${Number(n).toLocaleString('id-ID')}`;
}
// potong nama panjang tapi tetap kebaca
function trunc(s = '', max = 28) {
  s = String(s).trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
// keyboard utama
function mainKeyboard(balance = 0) {
  const top = [
    ['List Produk', `Saldo: Rp. ${balance.toLocaleString('id-ID')}`],
    ['Riwayat Transaksi'],
    ['✨ Produk Populer', '❓ Cara Order']
  ];
  return Markup.keyboard(top).resize().persistent();
}

const { TELEGRAM_BOT_TOKEN, PUBLIC_BASE_URL } = process.env;
if (!TELEGRAM_BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}
if (!PUBLIC_BASE_URL) {
  console.error('Missing PUBLIC_BASE_URL in .env (ngrok URL)');
  process.exit(1);
}

const STATUS = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FULFILLED: 'FULFILLED',
  FAILED: 'FAILED',
  CANCELED: 'CANCELED'
};

const prisma = new PrismaClient();
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const app = express();
app.use(express.json());
app.use(morgan('dev'));

// === START ===
bot.start(async (ctx) => {
  const tgId = String(ctx.from.id);
  await prisma.user.upsert({
    where: { telegramId: tgId },
    update: {
      username: ctx.from.username || null,
      firstName: ctx.from.first_name || null,
      lastName: ctx.from.last_name || null
    },
    create: {
      telegramId: tgId,
      username: ctx.from.username || null,
      firstName: ctx.from.first_name || null,
      lastName: ctx.from.last_name || null
    }
  });

  const saldo = 0;
  await ctx.reply(
    `Halo, ${esc(ctx.from.first_name || 'teman')}!\n` +
    `Selamat datang di <b>Marketplace Bot</b>.\n\n` +
    `<b>Perintah:</b>\n` +
    `• semua ada di tombol menu`,
    { parse_mode: 'HTML', reply_markup: mainKeyboard(saldo).reply_markup }
  );
});

// === [PATCH] Render katalog: 1 pesan per halaman + tombol & pagination (versi rapi) ===
async function renderProductList(ctx, page = 1, messageId) {
  page = Math.max(1, Number(page) || 1);

  const where = { isActive: true };
  const total = await prisma.product.count({ where });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > pages) page = pages;

const items = await prisma.product.findMany({
    where,
    orderBy: { id: 'asc' },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    select: { id: true, name: true, priceIDR: true, slug: true }
  });

  if (!items.length) { /* ... kosong: biarkan seperti sudah ada ... */ }

  // header ringkas
  const lines = [
    `📦 <b>LIST PRODUK</b>`,
    `page ${page} / ${pages}`,
    '',
    'Pilih produk di bawah ini:'
  ];

  // --- [OPTIMASI] hitung stok sekali untuk semua produk di halaman ini ---
  const ids = items.map(i => i.id);
  let stockMap = new Map();
  if (ids.length) {
    const grouped = await prisma.productCredential.groupBy({
      by: ['productId'],
      where: { productId: { in: ids }, isUsed: false },
      _count: { productId: true }
    });
    stockMap = new Map(grouped.map(g => [g.productId, g._count.productId]));
  }

  const keyboard = [];

  // satu tombol per produk (nama + harga + indikator)
  for (const p of items) {
    const stock = stockMap.get(p.id) ?? 0;
    const dot = stock > 0 ? '🟢' : '🔴';
    const label = `${trunc(p.name)} • ${shortIDR(p.priceIDR)} ${dot}`;

    keyboard.push([{
      text: label,
      callback_data: `INFO_${p.slug}_p${page}`
    }]);
  }

  // nav tetap
  const nav = [];
  if (page > 1) nav.push({ text: '◀️ Prev', callback_data: `CATALOG_${page - 1}` });
  nav.push({ text: `📄 ${page}/${pages}`, callback_data: 'NOOP' });
  if (page < pages) nav.push({ text: 'Next ▶️', callback_data: `CATALOG_${page + 1}` });
  keyboard.push(nav);

  const text = lines.join('\n');
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };

  if (messageId) {
    try { return await ctx.editMessageText(text, opts); }
    catch { return await ctx.reply(text, opts); }
  }
  return ctx.reply(text, opts);
}
// === [PATCH] Produk Populer: satu pesan + tombol per item ===
async function renderPopularList(ctx, messageId) {
  // ambil 5 item terbaru/terlaris (untuk simple: berdasarkan id desc)
  const items = await prisma.product.findMany({
    where: { isActive: true },
    orderBy: { id: 'desc' },
    take: 5,
    select: { id: true, name: true, priceIDR: true, slug: true }
  });

  if (!items.length) {
    const txt = '🔥 PRODUK POPULER\nBelum ada produk.';
    const opts = { parse_mode: 'HTML' };
    if (messageId) {
      try { return await ctx.editMessageText(txt, opts); }
      catch { return await ctx.reply(txt, opts); }
    }
    return ctx.reply(txt, opts);
  }

  // hitung stok sekali (hemat query)
  const ids = items.map(i => i.id);
  const grouped = await prisma.productCredential.groupBy({
    by: ['productId'],
    where: { productId: { in: ids }, isUsed: false },
    _count: { productId: true }
  });
  const stockMap = new Map(grouped.map(g => [g.productId, g._count.productId]));

  const lines = ['🔥 <b>PRODUK POPULER</b>', '', 'Pilih salah satu:'];
  const keyboard = [];

  for (const p of items) {
    const stock = stockMap.get(p.id) ?? 0;
    const dot = stock > 0 ? '🟢' : '🔴';
    keyboard.push([{
      text: `${p.name} • ${shortIDR(p.priceIDR)} ${dot}`,
      callback_data: `POPINFO_${p.slug}`
    }]);
  }

  // opsional: shortcut ke katalog lengkap
  keyboard.push([{ text: '📦 Lihat Semua', callback_data: 'CATALOG_1' }]);

  const text = lines.join('\n');
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };

  if (messageId) {
    try { return await ctx.editMessageText(text, opts); }
    catch { return await ctx.reply(text, opts); }
  }
  return ctx.reply(text, opts);
}
async function showProductList(ctx, page = 1, pageSize = 10) {
  page = Math.max(1, Number(page) || 1);
  const total = await prisma.product.count({ where: { isActive: true } });
  const items = await prisma.product.findMany({
    where: { isActive: true },
    orderBy: { id: 'asc' },
    skip: (page - 1) * pageSize,
    take: pageSize
  });
  if (!items.length) {
    return ctx.reply(page === 1 ? 'Produk belum tersedia.' : 'Tidak ada item di halaman ini.');
  }

  await ctx.reply(`📦 LIST PRODUK\npage ${page} / ${Math.max(1, Math.ceil(total / pageSize))}`);

  for (const p of items) {
  const stock = await prisma.productCredential.count({
    where: { productId: p.id, isUsed: false }
  });
  const status =stock > 0 ? '🟢 Tersedia' : '🔴 Habis';
  await ctx.reply(
      `<b>${esc(p.name)}</b> (${status})\n` +
      `${esc(p.description || '')}\n` +
      `Harga: ${formatIDR(p.priceIDR)}\n` +
      `Stock: ${stock}\n` +
      `Slug: <code>${esc(p.slug)}</code>`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: `🛒 Beli ${p.slug}`, callback_data: `BUY_${p.slug}` }]
        ]
      }
    }
  );
}
}

// === BUY ===
async function handleBuy(ctx, slug) {
  const product = await prisma.product.findUnique({ where: { slug } });
  if (!product || !product.isActive) return ctx.reply('Produk tidak ditemukan / tidak aktif.');

  const stock = await prisma.productCredential.count({ where: { productId: product.id, isUsed: false } });
  if (stock <= 0) return ctx.reply('Stok produk kosong.');

  const recent = await prisma.order.findFirst({
    where: {
      user: { telegramId: String(ctx.from.id) },
      productId: product.id,
      status: STATUS.PENDING,
      createdAt: { gte: new Date(Date.now() - 30 * 1000) }
    },
    orderBy: { id: 'desc' }
  });
  if (recent) {
    await ctx.reply(
      `🧾 Order <b>${esc(product.name)}</b>\n` +
      `Total: ${formatIDR(recent.priceIDR)}\n\n` +
      `Pilih metode pembayaran:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🧾 Snap (semua metode)', url: `${process.env.PUBLIC_BASE_URL}/thanks` }],
            [{ text: '🟦 QRIS (tampilkan QR di chat)', callback_data: `PAY_QRIS_${recent.orderId}` }]
          ]
        }
      }
    );
    return;
  }

  const tgId = String(ctx.from.id);
  const user = await prisma.user.upsert({
    where: { telegramId: tgId },
    update: { username: ctx.from.username || null, firstName: ctx.from.first_name || null, lastName: ctx.from.last_name || null },
    create: { telegramId: tgId, username: ctx.from.username || null, firstName: ctx.from.first_name || null, lastName: ctx.from.last_name || null }
  });

  const orderId = genOrderId('ORD');
  const order = await prisma.order.create({
    data: {
      orderId,
      userId: user.id,
      productId: product.id,
      priceIDR: product.priceIDR,
      status: STATUS.PENDING
    }
  });

  const snap = await createSnapTransaction({
    orderId: order.orderId,
    grossAmount: order.priceIDR,
    customer: {
      first_name: user.firstName || 'Telegram',
      last_name: user.lastName || 'User',
      email: `${user.username || 'user'}@telegram.local`
    }
  });

  await prisma.order.update({ where: { id: order.id }, data: { midtransOrderId: order.orderId } });

  await ctx.reply(
    `🧾 Order <b>${esc(product.name)}</b>\n` +
    `Total: ${formatIDR(product.priceIDR)}\n\n` +
    `Pilih metode pembayaran:`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🧾 Snap (semua metode)', url: snap.redirect_url }],
          [{ text: '🟦 QRIS (tampilkan QR di chat)', callback_data: `PAY_QRIS_${order.orderId}` }]
        ]
      }
    }
  );
}
// === Action lock (hindari double-processing klik yang sama) ===
const actionLocks = new Set(); // key: `${userId}:${data}`

async function withLock(key, fn) {
  if (actionLocks.has(key)) return null; // sudah berjalan
  actionLocks.add(key);
  try {
    return await fn();
  } finally {
    setTimeout(() => actionLocks.delete(key), 3000); // lepas setelah 3s
  }
}
// === Callback Handler (ADMIN_ / BUY_ / PAY_QRIS_ / CHK_) ===
bot.on('callback_query', async (ctx) => {
  const uid = String(ctx.from?.id || '');
  if (shouldThrottle(uid, 2000)) {
  return ctx.answerCbQuery('⏳ Tunggu sebentar...', { show_alert: false });
  }
  const data = ctx.callbackQuery?.data || '';
  console.log('[cbq]', data, 'from', ctx.from?.id);

  // -------- ADMIN callbacks guard --------
  if (data.startsWith('ADMIN_')) {
    if (!isAdminCtx(ctx)) {
      await ctx.answerCbQuery('Akses admin saja', { show_alert: true });
      return;
    }

    // mulai wizard tambah produk
    if (data === 'ADMIN_ADD_PRODUCT') {
      const s = getSess(ctx);
      s.step = 'NAME';
      s.data = {};
      await ctx.answerCbQuery('Mulai tambah produk…'); // hilangkan spinner
      await ctx.reply(
        '➕ Tambah Produk\n\nKetik *nama produk*:',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'ADMIN_CANCEL_WIZ' }]] } }
      );
      return;
    }

    // batal wizard
    if (data === 'ADMIN_CANCEL_WIZ') {
      clearSess(ctx);
      await ctx.answerCbQuery('Dibatalkan');
      await ctx.reply('Dibatalkan.');
      return;
    }

    // daftar produk
    if (data === 'ADMIN_LIST_PRODUCTS') {
      await ctx.answerCbQuery(); // tutup spinner
      const items = await prisma.product.findMany({ orderBy: { id: 'asc' } });
      if (!items.length) { await ctx.reply('Belum ada produk.'); return; }
      const lines = items.map(p => `• ${p.id}. ${p.name} — ${p.isActive ? 'AKTIF' : 'NONAKTIF'} — ${formatIDR(p.priceIDR)}`);
      await ctx.reply(lines.join('\n'));
      return;
    }

    // ringkas transaksi
    if (data === 'ADMIN_STATS') {
      await ctx.answerCbQuery();
      const [totalOrder, paid, fulfilled] = await Promise.all([
        prisma.order.count(),
        prisma.order.count({ where: { status: 'PAID' } }),
        prisma.order.count({ where: { status: 'FULFILLED' } }),
      ]);
      await ctx.reply(`Total order: ${totalOrder}\nPaid: ${paid}\nFulfilled: ${fulfilled}`);
      return;
    }
    // --- Mulai tambah stok untuk produk tertentu ---
    if (data.startsWith('ADMIN_ADD_STOCK_')) {
      const slug = data.replace('ADMIN_ADD_STOCK_', '');
      const product = await prisma.product.findUnique({ where: { slug } });
    if (!product) {
      await ctx.answerCbQuery('Produk tidak ditemukan', { show_alert: true });
      return;
    }
      const s = getSess(ctx);
      s.step = 'ADD_STOCK';
      s.data = { productId: product.id, productName: product.name };
      await ctx.answerCbQuery('Tambah stok…');
      await ctx.reply(
      `Kirim daftar credential untuk <b>${esc(product.name)}</b>\n` +
      `• Satu baris = satu kode/akun\n` +
      `• Bisa paste beberapa baris sekaligus\n\n` +
      `Ketik /cancel untuk batal.`,
    { parse_mode: 'HTML' }
    );
    return;
    }
    // simpan produk (point #4)
    if (data === 'ADMIN_CONFIRM_ADD_ACTIVE' || data === 'ADMIN_CONFIRM_ADD_INACTIVE') {
      const s = getSess(ctx);
      if (!s.step || !s.data?.name) {
        await ctx.answerCbQuery('Wizard tidak aktif', { show_alert: true });
        return;
      }
      const isActive = data === 'ADMIN_CONFIRM_ADD_ACTIVE';
      try {
        const p = await prisma.product.create({
          data: {
            name: s.data.name,
            slug: s.data.slug,
            description: s.data.description || '',
            priceIDR: s.data.priceIDR,
            isActive
          }
        });
        clearSess(ctx);
        try { await ctx.editMessageReplyMarkup(); } catch {}
        await ctx.answerCbQuery('Tersimpan!');
        await ctx.reply(
          `✅ Produk tersimpan.\n` +
          `<b>${esc(p.name)}</b> — ${formatIDR(p.priceIDR)}\n` +
          `Slug: <code>${esc(p.slug)}</code>\n` +
          `Status: ${p.isActive ? 'AKTIF' : 'NONAKTIF'}`,
          { parse_mode: 'HTML' }
        );
      } catch (e) {
        await ctx.answerCbQuery('Gagal menyimpan', { show_alert: true });
        await ctx.reply('Gagal menyimpan produk: ' + (e.message?.slice(0, 180) || e));
      }
      return;
    }

    return; // penting: hentikan di sini
  }
  // -------- [PATCH] label tengah (no-op) --------
  if (data === 'NOOP') {
    await ctx.answerCbQuery('Gunakan tombol Prev/Next ya 👌');
    return;
  }

  // -------- [PATCH] Catalog paging --------
  if (data.startsWith('CATALOG_')) {
    const page = Number(data.replace('CATALOG_', '')) || 1;
    await ctx.answerCbQuery();
    await renderProductList(ctx, page, ctx.callbackQuery?.message?.message_id);
    return;
  }

  // -------- [PATCH] Product detail (1 kartu) --------
  if (data.startsWith('INFO_')) {
    await ctx.answerCbQuery();
    // format: INFO_<slug>_p<page>
    const [, slug, ptag] = data.split('_');
    const page = Number((ptag || 'p1').replace(/^p/, '')) || 1;

    const p = await prisma.product.findUnique({ where: { slug } });
    if (!p) {
      await ctx.reply('Produk tidak ditemukan.');
      return;
    }
    const stock = await prisma.productCredential.count({
      where: { productId: p.id, isUsed: false }
    });
    const dot = stock > 0 ? '🟢 Tersedia' : '🔴 Habis';

    const txt =
      `<b>${esc(p.name)}</b>\n` +
      `${esc(p.description || '-')}\n\n` +
      `Harga: ${formatIDR(p.priceIDR)}\n` +
      `Stok: ${stock} (${dot})\n` +
      `Slug: <code>${esc(p.slug)}</code>`;

    const opts = {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🛒 Beli', callback_data: `BUY_${p.slug}` }],
          [{ text: '⬅️ Kembali', callback_data: `BACK_LIST_${page}` }]
        ]
      }
    };

    try { await ctx.editMessageText(txt, opts); }
    catch { await ctx.reply(txt, opts); }
    return;
  }

  // -------- [PATCH] Back to list --------
  if (data.startsWith('BACK_LIST_')) {
    const page = Number(data.replace('BACK_LIST_', '')) || 1;
    await ctx.answerCbQuery();
    await renderProductList(ctx, page, ctx.callbackQuery?.message?.message_id);
    return;
  }
  // -------- [PATCH] buka daftar populer --------
  if (data === 'POPULAR') {
    await ctx.answerCbQuery();
    await renderPopularList(ctx, ctx.callbackQuery?.message?.message_id);
    return;
  }

  // -------- [PATCH] detail dari populer --------
  if (data.startsWith('POPINFO_')) {
    await ctx.answerCbQuery();
    const slug = data.replace('POPINFO_', '');
    const p = await prisma.product.findUnique({ where: { slug } });
    if (!p) { await ctx.reply('Produk tidak ditemukan.'); return; }

    const stock = await prisma.productCredential.count({
      where: { productId: p.id, isUsed: false }
    });
    const dot = stock > 0 ? '🟢 Tersedia' : '🔴 Habis';

    const txt =
      `<b>${esc(p.name)}</b>\n` +
      `${esc(p.description || '-')}\n\n` +
      `Harga: ${formatIDR(p.priceIDR)}\n` +
      `Stok: ${stock} (${dot})\n` +
      `Slug: <code>${esc(p.slug)}</code>`;

    const opts = {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🛒 Beli', callback_data: `BUY_${p.slug}` }],
          [
            { text: '⬅️ Kembali (Populer)', callback_data: 'BACK_POP' },
            { text: '📦 Lihat Semua', callback_data: 'CATALOG_1' }
          ]
        ]
      }
    };

    try { await ctx.editMessageText(txt, opts); }
    catch { await ctx.reply(txt, opts); }
    return;
  }

  // -------- [PATCH] kembali ke daftar populer --------
  if (data === 'BACK_POP') {
    await ctx.answerCbQuery();
    await renderPopularList(ctx, ctx.callbackQuery?.message?.message_id);
    return;
  }
  // -------- BUY flow --------
  if (data.startsWith('BUY_')) {
  const key = `${ctx.from.id}:${data}`;
  const ran = await withLock(key, async () => {
    log(`[ORDER] ${ctx.from.username || ctx.from.id} klik BUY ${data}`);
    const slug = data.replace('BUY_', '');
    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[{ text: '⏳ Processing...', callback_data: 'NOOP' }]]
      });
    } catch {}
    await ctx.answerCbQuery('Memproses pesanan…');
    await handleBuy(ctx, slug);
  });
  if (ran === null) await ctx.answerCbQuery('⏳ Sedang diproses…');
  return;
}
  // -------- QRIS charge --------
  if (data.startsWith('PAY_QRIS_')) {
  const key = `${ctx.from.id}:${data}`;
  const ran = await withLock(key, async () => {
    log(`[PAY] ${ctx.from.username || ctx.from.id} minta QRIS untuk ${data}`);
    const orderId = data.replace('PAY_QRIS_', '');
    const order = await prisma.order.findUnique({
      where: { orderId },
      include: { product: true, user: true }
    });
    if (!order) {
      await ctx.answerCbQuery('Order tidak ditemukan', { show_alert: true });
      return;
    }

    try {
      const { qr_string, qr_url } = await chargeQris({
        orderId: order.orderId,
        grossAmount: order.priceIDR
      });
      let photo;
      if (qr_string) {
        const png = await QRCode.toBuffer(qr_string, { width: 460, margin: 1 });
        photo = { source: Buffer.from(png) };
      } else {
        const { default: axios } = await import('axios');
        const resp = await axios.get(qr_url, { responseType: 'arraybuffer' });
        photo = { source: Buffer.from(resp.data) };
      }
      await ctx.answerCbQuery();
      await ctx.replyWithPhoto(photo, {
        caption:
          `Scan QRIS untuk bayar <b>${esc(order.product.name)}</b>\n` +
          `Total: ${formatIDR(order.priceIDR)}\n\n` +
          `Catatan: QR berlaku ±15 menit. Setelah bayar, bot akan auto-kirim data.`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🔄 Cek status bayar', callback_data: `CHK_${order.orderId}` }]]
        }
      });
    } catch (e) {
      const hint = e.message?.slice(0, 300) || 'unknown';
      await ctx.answerCbQuery('Gagal membuat QRIS', { show_alert: true });
      await ctx.reply('Gagal membuat QRIS. Detail: ' + hint);
    }
  });
  if (ran === null) await ctx.answerCbQuery('⏳ Sedang diproses…');
  return;
}
  // -------- Cek status bayar --------
  if (data.startsWith('CHK_')) {
  const key = `${ctx.from.id}:${data}`;
  const ran = await withLock(key, async () => {
    log(`[CHECK] ${ctx.from.username || ctx.from.id} cek status ${data}`);
    const orderId = data.replace('CHK_', '');
    try {
      const st = await getTransactionStatus(orderId);
      await ctx.answerCbQuery(`Status: ${st.transaction_status || 'unknown'}`, { show_alert: true });
    } catch {
      await ctx.answerCbQuery('Gagal cek status', { show_alert: true });
    }
  });
  if (ran === null) await ctx.answerCbQuery('⏳ Sedang diproses…');
  return;
}
});
// === Webhook Midtrans ===
app.post('/midtrans/webhook', async (req, res) => {
  try {
    const body = req.body || {};
    if (!verifyMidtransSignature(body)) return res.status(403).json({ ok: false });
    const order = await prisma.order.findUnique({ where: { orderId: body.order_id }, include: { user: true, product: true } });
    if (!order) return res.status(404).json({ ok: false });
    const status = String(body.transaction_status || '').toLowerCase();

    if (isPaidStatus(status) && order.status !== STATUS.FULFILLED) {
      if (order.status !== STATUS.PAID) {
        await prisma.order.update({ where: { id: order.id }, data: { status: STATUS.PAID } });
      }
      const credential = await prisma.productCredential.findFirst({ where: { productId: order.productId, isUsed: false }, orderBy: { id: 'asc' } });
      if (!credential) {
        await notifyUser(order.user.telegramId, `Pembayaran <b>${esc(order.product.name)}</b> sukses ✅\nTapi stok habis, admin akan follow up.`, true);
        return res.json({ ok: true, note: 'Paid, no stock' });
      }
      await prisma.productCredential.update({ where: { id: credential.id }, data: { isUsed: true, usedAt: new Date() } });
      await prisma.order.update({ where: { id: order.id }, data: { status: STATUS.FULFILLED, deliveredPayload: credential.payload } });
      const msg =
        `Terima kasih! Pembayaran <b>${esc(order.product.name)}</b> sukses ✅\n\n` +
        `Data:\n<pre><code>${esc(credential.payload)}</code></pre>`;
      await notifyUser(order.user.telegramId, msg, true);
      return res.json({ ok: true, fulfilled: true });
    }

    if (['cancel', 'deny', 'expire', 'failure'].includes(status)) {
      await prisma.order.update({ where: { id: order.id }, data: { status: STATUS.FAILED } });
      await notifyUser(order.user.telegramId, `Transaksi <b>${esc(order.product.name)}</b> ${status.toUpperCase()}.`, true);
      return res.json({ ok: true });
    }
    return res.json({ ok: true, status });
  } catch (e) {
    error('midtrans webhook error', e);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

async function notifyUser(telegramId, message, html = false) {
  try {
    await bot.telegram.sendMessage(telegramId, message, html ? { parse_mode: 'HTML' } : undefined);
  } catch (e) { error('notifyUser error', e.message); }
}

// === Extra Menu ===
await bot.telegram.setMyCommands([
  { command: 'start', description: 'mulai bot' },
  { command: 'list',  description: 'daftar produk' },
  { command: 'stok',  description: 'laporan stok produk' },
  { command: 'saldo', description: 'cek saldo' },
  { command: 'admin', description: 'panel admin' },
  { command: 'help', description: "bantuan"}
]);
bot.command('help', async (ctx) => {
  await ctx.reply(
    '📖 Cara penggunaan bot:\n' +
    '• /list → lihat daftar produk\n' +
    '• /saldo → cek saldo kamu\n' +
    '• /stok → cek stok produk (user bisa lihat total stok)\n\n' +
    'Atau pakai tombol menu di bawah chat. 👇'
  );
});
// bot.command('list',  (ctx) => showProductList(ctx, 1));
bot.command('list',  (ctx) => renderProductList(ctx, 1));
bot.command('saldo', (ctx) => ctx.reply('Saldo kamu: Rp. 0'));

bot.command('stok',  async (ctx) => {
  const aktif = await prisma.product.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } });
  if (!aktif.length) return ctx.reply('Belum ada produk aktif.');
  const lines = [];
  for (const p of aktif) {
    const stock = await prisma.productCredential.count({ where: { productId: p.id, isUsed: false } });
    lines.push(`• ${p.name} — stok ${stock}`);
  }
  await ctx.reply(lines.join('\n'));
});
// === Admin panel (protected) ===
bot.command('admin', requireAdmin(async (ctx) => {
  await ctx.reply(
    '👑 Admin Panel\nPilih aksi:',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Tambah Produk', callback_data: 'ADMIN_ADD_PRODUCT' }],
          [{ text: '📦 Daftar Produk', callback_data: 'ADMIN_LIST_PRODUCTS' }],
          [{ text: '📊 Ringkas Transaksi', callback_data: 'ADMIN_STATS' }]
        ]
      }
    }
  );
}));
bot.command('stokadmin', requireAdmin(async (ctx) => {
  const items = await prisma.product.findMany({ orderBy: { id: 'asc' } });
  if (!items.length) return ctx.reply('Belum ada produk.');
  for (const p of items) {
    const stock = await prisma.productCredential.count({ where: { productId: p.id, isUsed: false } });
    await ctx.reply(
      `<b>${esc(p.name)}</b>\n` +
      `Harga: ${formatIDR(p.priceIDR)}\n` +
      `Status: ${p.isActive ? 'AKTIF' : 'NONAKTIF'}\n` +
      `Slug: <code>${esc(p.slug)}</code>\n` +
      `Stok: ${stock}`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Tambah Stok', callback_data: `ADMIN_ADD_STOCK_${p.slug}` }]
          ]
        }
      }
    );
  }
}));
// === Wizard Tambah Produk (khusus admin) ===
bot.on('text', async (ctx, next) => {
  const s = getSess(ctx);
  if (!s.step) return next();            // bukan sedang wizard
  if (!isAdminCtx(ctx)) return next();   // wizard hanya untuk admin

  const text = (ctx.message?.text || '').trim();

  // Allow cancel
  if (['/cancel', 'batal', 'cancel'].includes(text.toLowerCase())) {
    clearSess(ctx);
    await ctx.reply('Dibatalkan.');
    return;
  }

  if (s.step === 'NAME') {
    if (text.length < 3) return ctx.reply('Nama terlalu pendek. Ketik ulang nama produk:');
    s.data.name = text;
    s.step = 'PRICE';
    await ctx.reply('Masukkan *harga (IDR)* angka saja, contoh: `15000`', { parse_mode: 'Markdown' });
    return;
  }

  if (s.step === 'PRICE') {
    const price = Number(text.replace(/[._\s]/g, ''));
    if (!Number.isFinite(price) || price <= 0) {
      return ctx.reply('Harga tidak valid. Ketik angka saja, contoh: 15000');
    }
    s.data.priceIDR = price;
    s.step = 'DESC';
    await ctx.reply('Ketik *deskripsi* (atau "-" untuk kosong):', { parse_mode: 'Markdown' });
    return;
  }

  if (s.step === 'DESC') {
    s.data.description = text === '-' ? '' : text;

    const base = s.data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 40);
    s.data.suggestedSlug = base || `item-${Date.now().toString(36)}`;
    s.step = 'SLUG';
    await ctx.reply(
      `Slug default: \`${s.data.suggestedSlug}\`\nKetik *slug* untuk dipakai, atau kirim "-" untuk pakai default.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (s.step === 'SLUG') {
    s.data.slug = (text === '-' ? s.data.suggestedSlug : text)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/(^-|-$)/g, '');
    if (!s.data.slug) return ctx.reply('Slug tidak valid. Ketik lagi slugnya:');

    const exists = await prisma.product.findUnique({ where: { slug: s.data.slug } });
    if (exists) return ctx.reply('Slug sudah dipakai. Ketik slug lain:');

    s.step = 'CONFIRM';
    const preview =
      `<b>Konfirmasi Produk</b>\n` +
      `Nama : ${esc(s.data.name)}\n` +
      `Harga: ${formatIDR(s.data.priceIDR)}\n` +
      `Slug : <code>${esc(s.data.slug)}</code>\n` +
      `Desk : ${esc(s.data.description || '-')}\n\n` +
      `Aktifkan sekarang?`;
    await ctx.reply(preview, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Simpan & Aktifkan', callback_data: 'ADMIN_CONFIRM_ADD_ACTIVE' }],
          [{ text: '💾 Simpan (Nonaktif)', callback_data: 'ADMIN_CONFIRM_ADD_INACTIVE' }],
          [{ text: '❌ Batal', callback_data: 'ADMIN_CANCEL_WIZ' }],
        ]
      }
    });
    return;
  }

  // === Tambah stok (angka = jumlah, teks = daftar) ===
  if (s.step === 'ADD_STOCK') {
    const raw = text;

    // 1) angka → generate dummy
    if (/^\d+$/.test(raw)) {
      const n = Math.min(500, Math.max(1, parseInt(raw, 10)));
      const base = (s.data.productName || 'ITEM').toString().toUpperCase().replace(/[^A-Z0-9]+/g, '-');
      const stamp = Date.now().toString(36);
      try {
        let inserted = 0;
        for (let i = 1; i <= n; i++) {
          const payload = `${base}-${stamp}-${i}`;
          await prisma.productCredential.create({ data: { productId: s.data.productId, payload } });
          inserted++;
        }
        clearSess(ctx);
        await ctx.reply(`✅ ${inserted} credential dummy ditambahkan ke stok <b>${esc(s.data.productName || '')}</b>.`, { parse_mode: 'HTML' });
      } catch (e) {
        await ctx.reply('Gagal menambah stok: ' + (e.message?.slice(0, 180) || e));
      }
      return;
    }

    // 2) daftar baris
    const lines = raw.split(/\r?\n|,/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) {
      await ctx.reply('Tidak ada data. Kirim angka (jumlah) atau daftar credential (satu baris/satu item).');
      return;
    }

    try {
      const data = lines.map(payload => ({ productId: s.data.productId, payload }));
      const isSQLite = (process.env.DATABASE_URL || '').includes('sqlite') ||
                       (process.env.DATABASE_URL || '').startsWith('file:');

      let inserted = 0;
      if (prisma.productCredential.createMany && !isSQLite) {
        const res = await prisma.productCredential.createMany({ data, skipDuplicates: true });
        inserted = res.count ?? data.length;
      } else {
        for (const row of data) {
          try {
            await prisma.productCredential.create({ data: row });
            inserted++;
          } catch (e) {
            if (!String(e?.code || e?.message).includes('Unique') &&
                !String(e?.message).toLowerCase().includes('duplicate')) {
              throw e;
            }
          }
        }
      }
      clearSess(ctx);
      await ctx.reply(`✅ ${inserted} credential ditambahkan ke stok <b>${esc(s.data.productName || '')}</b>.`, { parse_mode: 'HTML' });
    } catch (e) {
      await ctx.reply('Gagal menambah stok: ' + (e.message?.slice(0, 180) || e));
    }
    return;
  }

  // kalau step tidak dikenali → teruskan ke handler lain
  return next();
});
// bot.hears('List Produk', async (ctx) => showProductList(ctx, 1));
bot.hears('List Produk', async (ctx) => renderProductList(ctx, 1));
bot.hears(/^Saldo: /, async (ctx) => ctx.reply(`Saldo kamu: Rp. 0`));
bot.hears('Riwayat Transaksi', async (ctx) => {
  const user = await prisma.user.findUnique({ where: { telegramId: String(ctx.from.id) } });
  const orders = await prisma.order.findMany({ where: { userId: user?.id }, orderBy: { id: 'desc' }, take: 10, include: { product: true } });
  if (!orders.length) return ctx.reply('Belum ada transaksi.');
  const lines = orders.map(o => `• ${o.orderId} — ${o.product?.name || '-'} — ${o.status} — ${formatIDR(o.priceIDR)}`);
  await ctx.reply(lines.join('\n'));
});
bot.hears('✨ Produk Populer', async (ctx) => renderPopularList(ctx));
bot.hears('❓ Cara Order', (ctx) =>
  ctx.reply(
    'Cara order:\n' +
    '1) Tekan <b>List Produk</b>.\n' +
    '2) Pilih item → <b>Beli</b>.\n' +
    '3) Bayar via Snap/QRIS.\n' +
    '4) Setelah pembayaran sukses, bot kirim akun/kode otomatis.',
    { parse_mode: 'HTML' }
  )
);

bot.launch().then(() => log('Telegram bot launched'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`HTTP server on :${PORT}`);
  log(`Webhook URL (Midtrans): ${PUBLIC_BASE_URL}/midtrans/webhook`);
});
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
