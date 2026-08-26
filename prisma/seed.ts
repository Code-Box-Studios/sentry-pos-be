import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { hashSecret } from '../src/auth/hashing';

/**
 * Dev seed (Task 22) — resets the database and inserts a tenant that matches the
 * FE mock (frontend/pos/src/api/mock/seed.ts) byte-for-byte, so a real terminal
 * can swap adapters without data surprises. Guarded to REFUSE when
 * NODE_ENV=production. Run with `npm run db:seed` (DB must be up + migrated).
 *
 * Seeds: a platform admin (random password printed once; TOTP enrolls on first
 * login) + owner Maria Reyes with the Kape Diaria business (+ a demo business),
 * branches Marikit/Bayanihan, the full catalog, and the FE stock levels.
 */

const prisma = new PrismaClient();

/** FE `pesos(n)` → centavos. */
const P = (php: number): number => php * 100;

const RECEIPT_HEADER = 'TIN 123-456-789-000';
const RECEIPT_FOOTER = 'Salamat po! Ingat!';

const SEED_OWNER = {
  email: 'maria@kapediaria.ph',
  password: 'sentry-demo',
  refundPin: '123456',
  name: 'Maria Reyes',
} as const;

const CATEGORIES = [
  { key: 'coffee', name: 'Coffee', sortOrder: 1 },
  { key: 'bakery', name: 'Bakery', sortOrder: 2 },
  { key: 'grocery', name: 'Grocery', sortOrder: 3 },
  { key: 'meals', name: 'Meals', sortOrder: 4 },
] as const;

const MODIFIER_GROUPS = [
  {
    key: 'milk',
    name: 'Milk',
    minSelect: 0,
    maxSelect: 1,
    modifiers: [
      { name: 'Oat milk', priceDeltaC: P(25) },
      { name: 'Fresh milk', priceDeltaC: 0 },
    ],
  },
  {
    key: 'addons',
    name: 'Add-ons',
    minSelect: 0,
    maxSelect: 3,
    modifiers: [
      { name: 'Extra shot', priceDeltaC: P(30) },
      { name: 'Vanilla', priceDeltaC: P(15) },
      { name: 'Less ice', priceDeltaC: 0 },
    ],
  },
] as const;

const DISCOUNTS = [
  { name: 'Merienda 10%', kind: 'percent', value: 10, appliesTo: 'both' },
  { name: '₱20 off', kind: 'fixed', value: P(20), appliesTo: 'order' },
  { name: 'Barkada 5%', kind: 'percent', value: 5, appliesTo: 'order' },
] as const;

interface ProductDef {
  key: string;
  categoryKey: string;
  name: string;
  sku: string;
  barcode?: string;
  priceC: number;
  soldBy?: 'unit' | 'weight';
  trackStock: boolean;
  lowStockThreshold?: number;
  variants?: { name: string; priceC: number }[];
  modifierGroupKeys?: string[];
}

const PRODUCTS: ProductDef[] = [
  {
    key: 'espresso',
    categoryKey: 'coffee',
    name: 'Espresso',
    sku: 'CF-101',
    priceC: P(85),
    trackStock: false,
  },
  {
    key: 'latte',
    categoryKey: 'coffee',
    name: 'Iced Latte',
    sku: 'CF-102',
    priceC: P(120),
    trackStock: false,
    variants: [
      { name: 'Small', priceC: P(120) },
      { name: 'Medium', priceC: P(130) },
      { name: 'Large', priceC: P(145) },
    ],
    modifierGroupKeys: ['milk', 'addons'],
  },
  {
    key: 'cappuccino',
    categoryKey: 'coffee',
    name: 'Cappuccino',
    sku: 'CF-103',
    priceC: P(120),
    trackStock: false,
  },
  {
    key: 'spanish',
    categoryKey: 'coffee',
    name: 'Spanish Latte',
    sku: 'CF-104',
    priceC: P(140),
    trackStock: false,
  },
  {
    key: 'pandesal',
    categoryKey: 'bakery',
    name: 'Pan de sal',
    sku: 'BK-101',
    priceC: P(12),
    trackStock: true,
    lowStockThreshold: 10,
  },
  {
    key: 'ensaymada',
    categoryKey: 'bakery',
    name: 'Ensaymada',
    sku: 'BK-102',
    priceC: P(55),
    trackStock: true,
    lowStockThreshold: 6,
  },
  {
    key: 'cheeseroll',
    categoryKey: 'bakery',
    name: 'Cheese roll',
    sku: 'BK-103',
    priceC: P(40),
    trackStock: true,
    lowStockThreshold: 4,
  },
  {
    key: 'ubeloaf',
    categoryKey: 'bakery',
    name: 'Ube loaf',
    sku: 'BK-104',
    priceC: P(120),
    trackStock: true,
    lowStockThreshold: 3,
  },
  {
    key: 'coke',
    categoryKey: 'grocery',
    name: 'Coke 1.5L',
    sku: 'GR-201',
    barcode: '4800888000015',
    priceC: P(98),
    trackStock: true,
    lowStockThreshold: 12,
  },
  {
    key: 'rice',
    categoryKey: 'grocery',
    name: 'Jasmine rice',
    sku: 'GR-202',
    priceC: P(95),
    soldBy: 'weight',
    trackStock: true,
    lowStockThreshold: 5,
  },
  {
    key: 'luckyme',
    categoryKey: 'meals',
    name: 'Lucky Me pancit',
    sku: 'GR-203',
    barcode: '4807770270019',
    priceC: P(15),
    trackStock: true,
    lowStockThreshold: 20,
  },
  {
    key: 'kopiko',
    categoryKey: 'grocery',
    name: 'Kopiko 3-in-1',
    sku: 'GR-204',
    barcode: '4800361413480',
    priceC: P(9),
    trackStock: true,
    lowStockThreshold: 24,
  },
];

/** productKey → on-hand qty (Decimal string), per the FE STOCK for branch Marikit. */
const STOCK: Record<string, string> = {
  pandesal: '8', // ≤ threshold 10 → LOW
  ensaymada: '14',
  cheeseroll: '9',
  ubeloaf: '0', // → OUT OF STOCK
  coke: '46',
  rice: '23.45',
  luckyme: '62',
  kopiko: '120',
};

/** Truncate every application table (mirrors the test helper). */
async function resetAll(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  `;
  for (const { tablename } of tables) {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "${tablename}" RESTART IDENTITY CASCADE`,
    );
  }
}

/** Insert the full catalog for a business; returns productKey → productId. */
async function seedCatalog(businessId: string): Promise<Map<string, string>> {
  const categoryId = new Map<string, string>();
  for (const c of CATEGORIES) {
    const row = await prisma.category.create({
      data: { businessId, name: c.name, sortOrder: c.sortOrder },
    });
    categoryId.set(c.key, row.id);
  }

  const groupId = new Map<string, string>();
  for (const g of MODIFIER_GROUPS) {
    const row = await prisma.modifierGroup.create({
      data: {
        businessId,
        name: g.name,
        minSelect: g.minSelect,
        maxSelect: g.maxSelect,
        modifiers: {
          create: g.modifiers.map((m) => ({
            name: m.name,
            priceDelta: m.priceDeltaC,
          })),
        },
      },
    });
    groupId.set(g.key, row.id);
  }

  const productId = new Map<string, string>();
  for (const p of PRODUCTS) {
    const row = await prisma.product.create({
      data: {
        businessId,
        categoryId: categoryId.get(p.categoryKey)!,
        name: p.name,
        sku: p.sku,
        barcode: p.barcode ?? null,
        price: p.priceC,
        soldBy: p.soldBy ?? 'unit',
        trackStock: p.trackStock,
        lowStockThreshold: p.lowStockThreshold ?? null,
        variants: p.variants
          ? {
              create: p.variants.map((v) => ({
                name: v.name,
                price: v.priceC,
              })),
            }
          : undefined,
        productModifierGroups: p.modifierGroupKeys
          ? {
              create: p.modifierGroupKeys.map((k) => ({
                groupId: groupId.get(k)!,
              })),
            }
          : undefined,
      },
    });
    productId.set(p.key, row.id);
  }

  for (const d of DISCOUNTS) {
    await prisma.discount.create({
      data: {
        businessId,
        name: d.name,
        kind: d.kind,
        value: d.value,
        appliesTo: d.appliesTo,
      },
    });
  }

  return productId;
}

/** Insert the FE stock levels on a branch. */
async function seedStock(
  branchId: string,
  productId: Map<string, string>,
): Promise<void> {
  for (const [key, qty] of Object.entries(STOCK)) {
    await prisma.branchStock.create({
      data: { branchId, productId: productId.get(key)!, variantId: null, qty },
    });
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed: NODE_ENV=production.');
    process.exit(1);
  }

  await resetAll();

  // Platform admin — random password printed once; TOTP enrolls on first login
  // (totpSecret stays null until then).
  const adminPassword = randomBytes(9).toString('base64url');
  await prisma.user.create({
    data: {
      email: 'admin@sentry.local',
      role: 'platform_admin',
      passwordHash: await hashSecret(adminPassword),
    },
  });

  // Owner + owner-user (the pairing sign-in identity).
  const owner = await prisma.owner.create({
    data: {
      name: SEED_OWNER.name,
      email: SEED_OWNER.email,
      status: 'active',
      maxBusinesses: 5,
    },
  });
  await prisma.user.create({
    data: {
      email: SEED_OWNER.email,
      role: 'owner',
      ownerId: owner.id,
      passwordHash: await hashSecret(SEED_OWNER.password),
      pinHash: await hashSecret(SEED_OWNER.refundPin),
    },
  });

  const businessData = {
    ownerId: owner.id,
    type: 'mixed' as const,
    currency: 'PHP',
    taxRate: '0.12',
    serviceChargeRate: '0.05',
    allowMiscItems: true,
    dayStartTime: '04:00',
    receiptHeader: RECEIPT_HEADER,
    receiptFooter: RECEIPT_FOOTER,
  };
  const kape = await prisma.business.create({
    data: { ...businessData, name: 'Kape Diaria', isDemo: false },
  });
  const demo = await prisma.business.create({
    data: { ...businessData, name: 'Kape Diaria (Demo)', isDemo: true },
  });

  const mkt = await prisma.branch.create({
    data: {
      businessId: kape.id,
      name: 'Marikit',
      code: 'MKT',
      address: '123 Gen. Ordoñez Ave, Marikina',
    },
  });
  await prisma.branch.create({
    data: {
      businessId: kape.id,
      name: 'Bayanihan',
      code: 'BYN',
      address: '88 Bayanihan St, Pasig',
    },
  });
  const demoBranch = await prisma.branch.create({
    data: {
      businessId: demo.id,
      name: 'Demo',
      code: 'DMO',
      address: 'Sandbox branch',
    },
  });

  const kapeProducts = await seedCatalog(kape.id);
  await seedStock(mkt.id, kapeProducts);
  const demoProducts = await seedCatalog(demo.id);
  await seedStock(demoBranch.id, demoProducts);

  console.log('\n✔ Seed complete.\n');
  console.log('  Platform admin');
  console.log('    email:    admin@sentry.local');
  console.log(
    `    password: ${adminPassword}   (shown once — TOTP enrolls on first login)`,
  );
  console.log('\n  Owner (POS pairing sign-in)');
  console.log(`    email:    ${SEED_OWNER.email}`);
  console.log(`    password: ${SEED_OWNER.password}`);
  console.log(`    refund PIN: ${SEED_OWNER.refundPin}`);
  console.log(
    '\n  Business "Kape Diaria" — branches Marikit (MKT), Bayanihan (BYN); demo business "Kape Diaria (Demo)".\n',
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
