import { Inject, Injectable } from '@nestjs/common';
import {
  Category,
  Discount,
  Modifier,
  ModifierGroup,
  Product,
  ProductVariant,
} from '@prisma/client';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../prisma/scoped-prisma.provider';
import { getContext } from '../../common/context/request-context';
import { NotFoundError } from '../../common/errors/api-errors';
import { StockService } from '../../portal/stock/stock.service';
import {
  BusinessSettings,
  serializeBusinessSettings,
} from '../business-settings';

// ---------------------------------------------------------------------------
// FE contract (frontend/pos/src/domain/types.ts) — the payload the POS pulls.
// These interfaces mirror the FE EXACTLY: cost is absent from every product and
// variant (portal-only, §6), and the business omits expiryWarningDays.
// ---------------------------------------------------------------------------

export interface CatalogBranch {
  id: string;
  name: string;
  code: string;
  address: string;
}

export interface CatalogVariant {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  priceC: number;
}

export interface CatalogProduct {
  id: string;
  categoryId: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  priceC: number;
  soldBy: Product['soldBy'];
  lowStockThreshold: number | null;
  trackStock: boolean;
  active: boolean;
  variants: CatalogVariant[];
  modifierGroupIds: string[];
}

export interface CatalogCategory {
  id: string;
  name: string;
  sortOrder: number;
}

export interface CatalogModifier {
  id: string;
  name: string;
  priceDeltaC: number;
}

export interface CatalogModifierGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  modifiers: CatalogModifier[];
}

export interface CatalogDiscount {
  id: string;
  name: string;
  kind: Discount['kind'];
  value: number;
  appliesTo: Discount['appliesTo'];
  active: boolean;
}

export interface CatalogStockLevel {
  productId: string;
  variantId: string | null;
  qty: number;
}

export interface CatalogPayload {
  business: BusinessSettings;
  branch: CatalogBranch;
  terminal: { name: string; code: string };
  categories: CatalogCategory[];
  products: CatalogProduct[];
  modifierGroups: CatalogModifierGroup[];
  discounts: CatalogDiscount[];
  stock: CatalogStockLevel[];
  loadedAt: string;
}

// The exact product read shape (live variants + live modifier-group links).
type ProductRow = Product & {
  variants: ProductVariant[];
  productModifierGroups: { groupId: string }[];
};
type GroupRow = ModifierGroup & { modifiers: Modifier[] };

// ---------------------------------------------------------------------------
// Serializers — each WHITELISTS only the FE fields. This is the guarantee that
// `cost` (product + variant) never crosses to the POS: it is simply never read.
// ---------------------------------------------------------------------------

function serializeVariant(v: ProductVariant): CatalogVariant {
  return {
    id: v.id,
    name: v.name,
    sku: v.sku,
    barcode: v.barcode,
    priceC: v.price,
  };
}

function serializeProduct(
  p: ProductRow,
  liveGroupIds: ReadonlySet<string>,
): CatalogProduct {
  return {
    id: p.id,
    categoryId: p.categoryId,
    name: p.name,
    sku: p.sku,
    barcode: p.barcode,
    priceC: p.price,
    soldBy: p.soldBy,
    lowStockThreshold:
      p.lowStockThreshold === null ? null : p.lowStockThreshold.toNumber(),
    trackStock: p.trackStock,
    active: p.active,
    variants: p.variants.map(serializeVariant),
    // Only IDs of modifier groups that are themselves live in this catalog —
    // a link can outlive its (archived) group, so drop dangling references.
    modifierGroupIds: p.productModifierGroups
      .map((l) => l.groupId)
      .filter((id) => liveGroupIds.has(id)),
  };
}

function serializeCategory(c: Category): CatalogCategory {
  return { id: c.id, name: c.name, sortOrder: c.sortOrder };
}

function serializeGroup(g: GroupRow): CatalogModifierGroup {
  return {
    id: g.id,
    name: g.name,
    minSelect: g.minSelect,
    maxSelect: g.maxSelect,
    modifiers: g.modifiers.map((m) => ({
      id: m.id,
      name: m.name,
      priceDeltaC: m.priceDelta,
    })),
  };
}

function serializeDiscount(d: Discount): CatalogDiscount {
  return {
    id: d.id,
    name: d.name,
    kind: d.kind,
    value: d.value,
    appliesTo: d.appliesTo,
    active: d.active,
  };
}

/**
 * Task 17 — the POS catalog pull. A paired terminal (TerminalGuard has stamped a
 * tenant scope pinned to its branch) reads the whole sellable catalog for its
 * business in one shot. Everything flows through the ScopedPrisma choke point,
 * so reads are auto-scoped to the terminal's owner/business/branch and exclude
 * soft-deleted rows. Two POS-specific rules on top of scoping: only ACTIVE
 * products/discounts are returned, and COST is never serialized (portal-only).
 * Stock reuses the shared `StockService.levels` (projected to id/variant/qty).
 */
@Injectable()
export class PosCatalogService {
  constructor(
    @Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma,
    private readonly stock: StockService,
  ) {}

  async pull(): Promise<CatalogPayload> {
    const ctx = getContext();
    const businessId = ctx.businessId!;
    const branchId = ctx.branchId!;
    const terminalId = ctx.actor?.id;

    const business = await this.scoped.business.findFirst({
      where: { id: businessId },
    });
    if (!business) throw new NotFoundError('Business not found.');

    const branch = await this.scoped.branch.findFirst({
      where: { id: branchId },
    });
    if (!branch) throw new NotFoundError('Branch not found.');

    const terminal = await this.scoped.terminal.findFirst({
      where: { id: terminalId },
    });
    if (!terminal) throw new NotFoundError('Terminal not found.');

    const categories = await this.scoped.category.findMany({
      where: { businessId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const products: ProductRow[] = await this.scoped.product.findMany({
      where: { businessId, active: true },
      include: {
        variants: { orderBy: { createdAt: 'asc' } },
        // to-MANY include: the choke point injects deletedAt:null, so only live
        // links come back (safe here — the to-one include bug only bites to-one).
        productModifierGroups: { select: { groupId: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const modifierGroups: GroupRow[] = await this.scoped.modifierGroup.findMany(
      {
        where: { businessId },
        include: { modifiers: { orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      },
    );

    const discounts = await this.scoped.discount.findMany({
      where: { businessId, active: true },
      orderBy: { createdAt: 'asc' },
    });

    // Stock via the shared mutator's read side, projected to the FE StockLevel
    // (drops the productName/variantName the portal surface carries).
    const levels = await this.stock.levels(branchId);

    const liveGroupIds = new Set(modifierGroups.map((g) => g.id));

    return {
      business: serializeBusinessSettings(business),
      branch: {
        id: branch.id,
        name: branch.name,
        code: branch.code,
        address: branch.address,
      },
      terminal: { name: terminal.name, code: terminal.code },
      categories: categories.map(serializeCategory),
      products: products.map((p) => serializeProduct(p, liveGroupIds)),
      modifierGroups: modifierGroups.map(serializeGroup),
      discounts: discounts.map(serializeDiscount),
      stock: levels.map((l) => ({
        productId: l.productId,
        variantId: l.variantId,
        qty: l.qty,
      })),
      loadedAt: new Date().toISOString(),
    };
  }
}
