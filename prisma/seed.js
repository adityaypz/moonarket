import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const products = [
    {
      name: 'Netflix 1 Month',
      slug: 'netflix-1m',
      description: 'Akun/slot Netflix aktif 1 bulan',
      priceIDR: 35000,
      credentials: [
        { payload: 'email: user1@mail.com | pass: 12345' },
        { payload: 'email: user2@mail.com | pass: 12345' }
      ]
    },
    {
      name: 'Spotify Premium 1 Month',
      slug: 'spotify-1m',
      description: 'Akun/slot Spotify Premium aktif 1 bulan',
      priceIDR: 25000,
      credentials: [
        { payload: 'email: spot1@mail.com | pass: abcde' },
        { payload: 'email: spot2@mail.com | pass: abcde' }
      ]
    }
  ];

  for (const p of products) {
    await prisma.product.upsert({
      where: { slug: p.slug },
      update: {},
      create: {
        name: p.name,
        slug: p.slug,
        description: p.description,
        priceIDR: p.priceIDR,
        credentials: { create: p.credentials }
      }
    });
  }
  console.log('Seed done');
}

main().finally(() => prisma.$disconnect());
