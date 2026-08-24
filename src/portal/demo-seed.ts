import { Prisma } from '@prisma/client';

/**
 * Task 9 — demo-business provisioning.
 *
 * `seedDemoBusiness(tx, ownerId)` creates one `is_demo` business named exactly
 * "Kape Diaria (Demo)" whose catalog + stock mirror the FE mock seed
 * (frontend/pos/src/api/mock/seed.ts) so Task 22's parity holds. The FE mock is
 * the source of truth; prices are in centavos (FE `pesos(n)` === n * 100).
 *
 * This runs on the RAW client (bypasses the tenancy choke point — there is no
 * request scope during invite acceptance and a brand-new owner has no business
 * to scope to yet) and is ALWAYS invoked inside the invite-accept `$transaction`
 * (`tx` is the transaction client). A failure part-way through therefore rolls
 * back the whole accept, so the seed's non-idempotence never leaves a half-built
 * demo behind. Exactly one summary audit row (`business.demo_seeded`,
 * actor = the owner) is written.
 *
 * The business is created with `isDemo = true`, which excludes it from
 * `max_businesses` counting (the cap enforcement lands in Task 11).
 */

const DEMO_BUSINESS_NAME = 'Kape Diaria (Demo)';
const RECEIPT_HEADER = 'TIN 123-456-789-000';
const RECEIPT_FOOTER = 'Salamat po! Ingat!';

/** FE `pesos(n)` — pesos to centavos. */
function pesos(p: number): number {
  return Math.round(p * 100);
}

// ---------------------------------------------------------------------------
// Catalog definition — verbatim from the FE mock seed's demo business.
// ---------------------------------------------------------------------------

interface SeedCategory {
  key: string;
  name: string;
  sortOrder: number;
}

interface SeedVariant {
  name: string;
  sku: string | null;
  barcode: string | null;
  price: number;
}

interface SeedProduct {
  key: string;
  categoryKey: string;
  name: string;
  sku: string;
  barcode: string | null;
  price: number;
  soldBy: 'unit' | 'weight';
  trackStock: boolean;
  lowStockThreshold: number | null;
  variants: SeedVariant[];
  modifierGroupKeys: string[];
}

interface SeedModifier {
  name: string;
  priceDelta: number;
}

interface SeedModifierGroup {
  key: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  modifiers: SeedModifier[];
}

interface SeedDiscount {
  name: string;
  kind: 'percent' | 'fixed';
  value: number;
  appliesTo: 'line' | 'order' | 'both';
  active: boolean;
}

const CATEGORIES: SeedCategory[] = [
  { key: 'cat-coffee', name: 'Coffee', sortOrder: 1 },
  { key: 'cat-bakery', name: 'Bakery', sortOrder: 2 },
  { key: 'cat-grocery', name: 'Grocery', sortOrder: 3 },
  { key: 'cat-meals', name: 'Meals', sortOrder: 4 },
];

const MODIFIER_GROUPS: SeedModifierGroup[] = [
  {
    key: 'mg-milk',
    name: 'Milk',
    minSelect: 0,
    maxSelect: 1,
    modifiers: [
      { name: 'Oat milk', priceDelta: pesos(25) },
      { name: 'Fresh milk', priceDelta: 0 },
    ],
  },
  {
    key: 'mg-addons',
    name: 'Add-ons',
    minSelect: 0,
    maxSelect: 3,
    modifiers: [
      { name: 'Extra shot', priceDelta: pesos(30) },
      { name: 'Vanilla', priceDelta: pesos(15) },
      { name: 'Less ice', priceDelta: 0 },
    ],
  },
];

const DISCOUNTS: SeedDiscount[] = [
  {
    name: 'Merienda 10%',
    kind: 'percent',
    value: 10,
    appliesTo: 'both',
    active: true,
  },
  {
    name: '₱20 off',
    kind: 'fixed',
    value: pesos(20),
    appliesTo: 'order',
    active: true,
  },
  {
    name: 'Barkada 5%',
    kind: 'percent',
    value: 5,
    appliesTo: 'order',
    active: true,
  },
];

const PRODUCTS: SeedProduct[] = [
  // Coffee (untracked — priced off the counter menu in the FE mock).
  {
    key: 'prod-espresso',
    categoryKey: 'cat-coffee',
    name: 'Espresso',
    sku: 'CF-101',
    barcode: null,
    price: pesos(85),
    soldBy: 'unit',
    trackStock: false,
    lowStockThreshold: null,
    variants: [],
    modifierGroupKeys: [],
  },
  {
    key: 'prod-latte',
    categoryKey: 'cat-coffee',
    name: 'Iced Latte',
    sku: 'CF-102',
    barcode: null,
    price: pesos(120),
    soldBy: 'unit',
    trackStock: false,
    lowStockThreshold: null,
    variants: [
      { name: 'Small', sku: null, barcode: null, price: pesos(120) },
      { name: 'Medium', sku: null, barcode: null, price: pesos(130) },
      { name: 'Large', sku: null, barcode: null, price: pesos(145) },
    ],
    modifierGroupKeys: ['mg-milk', 'mg-addons'],
  },
  {
    key: 'prod-cappuccino',
    categoryKey: 'cat-coffee',
    name: 'Cappuccino',
    sku: 'CF-103',
    barcode: null,
    price: pesos(120),
    soldBy: 'unit',
    trackStock: false,
    lowStockThreshold: null,
    variants: [],
    modifierGroupKeys: [],
  },
  {
    key: 'prod-spanish',
    categoryKey: 'cat-coffee',
    name: 'Spanish Latte',
    sku: 'CF-104',
    barcode: null,
    price: pesos(140),
    soldBy: 'unit',
    trackStock: false,
    lowStockThreshold: null,
    variants: [],
    modifierGroupKeys: [],
  },
  // Bakery (tracked).
  {
    key: 'prod-pandesal',
    categoryKey: 'cat-bakery',
    name: 'Pan de sal',
    sku: 'BK-101',
    barcode: null,
    price: pesos(12),
    soldBy: 'unit',
    trackStock: true,
    lowStockThreshold: 10,
    variants: [],
    modifierGroupKeys: [],
  },
  {
    key: 'prod-ensaymada',
    categoryKey: 'cat-bakery',
    name: 'Ensaymada',
    sku: 'BK-102',
    barcode: null,
    price: pesos(55),
    soldBy: 'unit',
    trackStock: true,
    lowStockThreshold: 6,
    variants: [],
    modifierGroupKeys: [],
  },
  {
    key: 'prod-cheeseroll',
    categoryKey: 'cat-bakery',
    name: 'Cheese roll',
    sku: 'BK-103',
    barcode: null,
    price: pesos(40),
    soldBy: 'unit',
    trackStock: true,
    lowStockThreshold: 4,
    variants: [],
    modifierGroupKeys: [],
  },
  {
    key: 'prod-ubeloaf',
    categoryKey: 'cat-bakery',
    name: 'Ube loaf',
    sku: 'BK-104',
    barcode: null,
    price: pesos(120),
    soldBy: 'unit',
    trackStock: true,
    lowStockThreshold: 3,
    variants: [],
    modifierGroupKeys: [],
  },
  // Grocery + Meals (tracked). Note: the FE mock keys "Lucky Me pancit" under
  // cat-meals though its SKU is in the GR-series — replicated verbatim.
  {
    key: 'prod-coke',
    categoryKey: 'cat-grocery',
    name: 'Coke 1.5L',
    sku: 'GR-201',
    barcode: '4800888000015',
    price: pesos(98),
    soldBy: 'unit',
    trackStock: true,
    lowStockThreshold: 12,
    variants: [],
    modifierGroupKeys: [],
  },
  {
    key: 'prod-rice',
    categoryKey: 'cat-grocery',
    name: 'Jasmine rice',
    sku: 'GR-202',
    barcode: null,
    price: pesos(95),
    soldBy: 'weight',
    trackStock: true,
    lowStockThreshold: 5,
    variants: [],
    modifierGroupKeys: [],
  },
  {
    key: 'prod-luckyme',
    categoryKey: 'cat-meals',
    name: 'Lucky Me pancit',
    sku: 'GR-203',
    barcode: '4807770270019',
    price: pesos(15),
    soldBy: 'unit',
    trackStock: true,
    lowStockThreshold: 20,
    variants: [],
    modifierGroupKeys: [],
  },
  {
    key: 'prod-kopiko',
    categoryKey: 'cat-grocery',
    name: 'Kopiko 3-in-1',
    sku: 'GR-204',
    barcode: '4800361413480',
    price: pesos(9),
    soldBy: 'unit',
    trackStock: true,
    lowStockThreshold: 24,
    variants: [],
    modifierGroupKeys: [],
  },
];

/** Stock levels for the single seeded branch (FE mock uses SEED_BRANCHES[0]). */
const STOCK: { productKey: string; qty: number }[] = [
  { productKey: 'prod-pandesal', qty: 8 }, // ≤ threshold 10 → LOW
  { productKey: 'prod-ensaymada', qty: 14 },
  { productKey: 'prod-cheeseroll', qty: 9 },
  { productKey: 'prod-ubeloaf', qty: 0 }, // → OUT OF STOCK
  { productKey: 'prod-coke', qty: 46 },
  { productKey: 'prod-rice', qty: 23.45 },
  { productKey: 'prod-luckyme', qty: 62 },
  { productKey: 'prod-kopiko', qty: 120 },
];

/** Marikit branch (FE mock SEED_BRANCHES[0]). */
const DEMO_BRANCH = {
  name: 'Marikit',
  code: 'MKT',
  address: '123 Gen. Ordoñez Ave, Marikina',
} as const;

/**
 * Provision the demo business for a freshly-activated owner. Returns the new
 * business id. Idempotency is NOT built in — call once, on invite acceptance,
 * inside a transaction (`tx`) so a partial failure rolls the whole accept back.
 */
export async function seedDemoBusiness(
  tx: Prisma.TransactionClient,
  ownerId: string,
): Promise<string> {
  const business = await tx.business.create({
    data: {
      ownerId,
      name: DEMO_BUSINESS_NAME,
      type: 'mixed',
      currency: 'PHP',
      taxRate: '0.12',
      serviceChargeRate: '0.05',
      allowMiscItems: true,
      isDemo: true,
      dayStartTime: '04:00',
      receiptHeader: RECEIPT_HEADER,
      receiptFooter: RECEIPT_FOOTER,
    },
  });

  const branch = await tx.branch.create({
    data: {
      businessId: business.id,
      name: DEMO_BRANCH.name,
      code: DEMO_BRANCH.code,
      address: DEMO_BRANCH.address,
    },
  });

  // Categories.
  const categoryIdByKey = new Map<string, string>();
  for (const cat of CATEGORIES) {
    const row = await tx.category.create({
      data: {
        businessId: business.id,
        name: cat.name,
        sortOrder: cat.sortOrder,
      },
    });
    categoryIdByKey.set(cat.key, row.id);
  }

  // Modifier groups + their modifiers.
  const groupIdByKey = new Map<string, string>();
  for (const group of MODIFIER_GROUPS) {
    const row = await tx.modifierGroup.create({
      data: {
        businessId: business.id,
        name: group.name,
        minSelect: group.minSelect,
        maxSelect: group.maxSelect,
        modifiers: {
          create: group.modifiers.map((m) => ({
            name: m.name,
            priceDelta: m.priceDelta,
          })),
        },
      },
    });
    groupIdByKey.set(group.key, row.id);
  }

  // Discounts.
  for (const disc of DISCOUNTS) {
    await tx.discount.create({
      data: {
        businessId: business.id,
        name: disc.name,
        kind: disc.kind,
        value: disc.value,
        appliesTo: disc.appliesTo,
        active: disc.active,
      },
    });
  }

  // Products (+ variants + product↔modifier-group links).
  const productIdByKey = new Map<string, string>();
  for (const prod of PRODUCTS) {
    const categoryId = categoryIdByKey.get(prod.categoryKey);
    if (!categoryId) {
      throw new Error(`demo seed: unknown category ${prod.categoryKey}`);
    }
    const row = await tx.product.create({
      data: {
        businessId: business.id,
        categoryId,
        name: prod.name,
        sku: prod.sku,
        barcode: prod.barcode,
        price: prod.price,
        soldBy: prod.soldBy,
        trackStock: prod.trackStock,
        lowStockThreshold:
          prod.lowStockThreshold === null
            ? null
            : String(prod.lowStockThreshold),
        active: true,
        variants: {
          create: prod.variants.map((v) => ({
            name: v.name,
            sku: v.sku,
            barcode: v.barcode,
            price: v.price,
          })),
        },
        productModifierGroups: {
          create: prod.modifierGroupKeys.map((groupKey) => {
            const groupId = groupIdByKey.get(groupKey);
            if (!groupId) {
              throw new Error(`demo seed: unknown modifier group ${groupKey}`);
            }
            return { groupId };
          }),
        },
      },
    });
    productIdByKey.set(prod.key, row.id);
  }

  // Branch stock (only for tracked products present in STOCK).
  for (const level of STOCK) {
    const productId = productIdByKey.get(level.productKey);
    if (!productId) {
      throw new Error(`demo seed: unknown product ${level.productKey}`);
    }
    await tx.branchStock.create({
      data: {
        branchId: branch.id,
        productId,
        variantId: null,
        qty: String(level.qty),
      },
    });
  }

  // Exactly one summary audit row, actor = the owner.
  await tx.auditLog.create({
    data: {
      actorType: 'owner',
      actorId: ownerId,
      ownerId,
      businessId: business.id,
      action: 'business.demo_seeded',
      entityType: 'business',
      entityId: business.id,
      changes: {},
      metadata: {
        name: DEMO_BUSINESS_NAME,
        categories: CATEGORIES.length,
        products: PRODUCTS.length,
        modifierGroups: MODIFIER_GROUPS.length,
        discounts: DISCOUNTS.length,
        stockLevels: STOCK.length,
      },
    },
  });

  return business.id;
}
