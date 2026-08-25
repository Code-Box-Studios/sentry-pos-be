import { Inject, Injectable } from '@nestjs/common';
import { Prisma, Product, ProductVariant } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../prisma/scoped-prisma.provider';
import {
  NotFoundError,
  ValidationFailedError,
} from '../../common/errors/api-errors';
import { assertBusinessOwned } from '../shared/tenant-guards';
import { CreateProductDto, VariantInputDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

type ProductWithVariants = Prisma.ProductGetPayload<{
  include: { variants: true };
}>;

/**
 * Variants load oldest-first within a product (stable display order); products
 * themselves list newest-first (see `list`). The choke point injects
 * `deletedAt: null`, so only live variants come back.
 */
const VARIANTS_INCLUDE = {
  variants: { orderBy: { createdAt: 'asc' as const } },
};

export interface VariantResponse {
  id: string;
  productId: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  priceC: number;
  costC: number | null;
}

export interface ProductResponse {
  id: string;
  businessId: string;
  categoryId: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  priceC: number;
  costC: number | null;
  soldBy: Product['soldBy'];
  lowStockThreshold: number | null;
  imagePath: string | null;
  trackStock: boolean;
  trackExpiry: boolean;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  variants: VariantResponse[];
}

function serializeVariant(v: ProductVariant): VariantResponse {
  return {
    id: v.id,
    productId: v.productId,
    name: v.name,
    sku: v.sku,
    barcode: v.barcode,
    priceC: v.price,
    costC: v.cost,
  };
}

/** Map the schema (price/cost centavos, Decimal lowStockThreshold) → the API. */
function serializeProduct(
  p: Product & { variants?: ProductVariant[] },
): ProductResponse {
  return {
    id: p.id,
    businessId: p.businessId,
    categoryId: p.categoryId,
    name: p.name,
    sku: p.sku,
    barcode: p.barcode,
    priceC: p.price,
    costC: p.cost,
    soldBy: p.soldBy,
    lowStockThreshold:
      p.lowStockThreshold === null ? null : p.lowStockThreshold.toNumber(),
    imagePath: p.imagePath,
    trackStock: p.trackStock,
    trackExpiry: p.trackExpiry,
    active: p.active,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    deletedAt: p.deletedAt,
    variants: (p.variants ?? []).map(serializeVariant),
  };
}

/** Non-null, non-empty identifiers from a product + its variants. */
function collect(
  own: string | null | undefined,
  many: (string | null | undefined)[],
): string[] {
  return [own, ...many].filter((x): x is string => x != null && x !== '');
}

function firstDuplicate(values: string[]): string | null {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) return v;
    seen.add(v);
  }
  return null;
}

/**
 * The Task 2 partial unique indexes (products.business_id+sku / +barcode) are the
 * DB backstop; they surface as Prisma P2002. Map to the same 422 the service
 * check uses (meta may lack field names for raw partial indexes).
 */
function mapCatalogWriteError(err: unknown): never {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002'
  ) {
    const target: unknown = err.meta?.target;
    const t = Array.isArray(target)
      ? target.join(',')
      : typeof target === 'string'
        ? target
        : '';
    const field = /barcode/i.test(t) ? 'barcode' : 'SKU';
    throw new ValidationFailedError(`This ${field} is already in use.`);
  }
  throw err;
}

/**
 * Task 12 — portal product CRUD with nested variants (tenant scope).
 *
 * Reads/writes flow through the ScopedPrisma choke point (owner-scoping,
 * businessId create-policing, soft-delete, mutation audit incl. nested variant
 * writes). Two things the choke point can't do live here: (1) SKU/barcode
 * uniqueness that spans BOTH products and product_variants business-wide (no DB
 * constraint can), and (2) archive-instead-of-delete for products with sales
 * history (§6). `price`/`cost` are centavos ints exposed as `priceC`/`costC`.
 */
@Injectable()
export class ProductsService {
  constructor(
    @Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma,
    private readonly raw: PrismaService,
  ) {}

  async list(businessId: string): Promise<ProductResponse[]> {
    await assertBusinessOwned(this.scoped, businessId);
    const rows = await this.scoped.product.findMany({
      where: { businessId },
      include: VARIANTS_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(serializeProduct);
  }

  async get(id: string): Promise<ProductResponse> {
    return serializeProduct(await this.loadOwned(id));
  }

  async create(
    businessId: string,
    dto: CreateProductDto,
  ): Promise<ProductResponse> {
    await assertBusinessOwned(this.scoped, businessId);
    await this.assertCategoryInBusiness(businessId, dto.categoryId);

    const variants = dto.variants ?? [];
    await this.assertUniqueIdentifiers(
      businessId,
      null,
      collect(
        dto.sku,
        variants.map((v) => v.sku),
      ),
      collect(
        dto.barcode,
        variants.map((v) => v.barcode),
      ),
    );

    try {
      const created = await this.scoped.product.create({
        data: {
          businessId,
          categoryId: dto.categoryId,
          name: dto.name,
          sku: dto.sku ?? null,
          barcode: dto.barcode ?? null,
          price: dto.priceC,
          cost: dto.costC ?? null,
          ...(dto.soldBy !== undefined ? { soldBy: dto.soldBy } : {}),
          ...(dto.lowStockThreshold !== undefined
            ? { lowStockThreshold: dto.lowStockThreshold }
            : {}),
          ...(dto.trackStock !== undefined
            ? { trackStock: dto.trackStock }
            : {}),
          ...(dto.trackExpiry !== undefined
            ? { trackExpiry: dto.trackExpiry }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          ...(dto.imagePath !== undefined ? { imagePath: dto.imagePath } : {}),
          variants: {
            create: variants.map((v) => ({
              name: v.name,
              sku: v.sku ?? null,
              barcode: v.barcode ?? null,
              price: v.priceC,
              cost: v.costC ?? null,
            })),
          },
        },
        include: VARIANTS_INCLUDE,
      });
      return serializeProduct(created);
    } catch (err) {
      mapCatalogWriteError(err);
    }
  }

  async update(id: string, dto: UpdateProductDto): Promise<ProductResponse> {
    const current = await this.loadOwned(id);
    const businessId = current.businessId;
    if (dto.categoryId !== undefined) {
      await this.assertCategoryInBusiness(businessId, dto.categoryId);
    }

    // Final identifier state for the uniqueness check. When `variants` is
    // provided it replaces the set; otherwise the current variants stand.
    const finalSku = dto.sku !== undefined ? dto.sku : current.sku;
    const finalBarcode =
      dto.barcode !== undefined ? dto.barcode : current.barcode;
    const finalVariants = dto.variants ?? current.variants;
    await this.assertUniqueIdentifiers(
      businessId,
      id,
      collect(
        finalSku,
        finalVariants.map((v) => v.sku),
      ),
      collect(
        finalBarcode,
        finalVariants.map((v) => v.barcode),
      ),
    );

    const data: Prisma.ProductUpdateInput = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.categoryId !== undefined
        ? { category: { connect: { id: dto.categoryId } } }
        : {}),
      ...(dto.sku !== undefined ? { sku: dto.sku } : {}),
      ...(dto.barcode !== undefined ? { barcode: dto.barcode } : {}),
      ...(dto.priceC !== undefined ? { price: dto.priceC } : {}),
      ...(dto.costC !== undefined ? { cost: dto.costC } : {}),
      ...(dto.soldBy !== undefined ? { soldBy: dto.soldBy } : {}),
      ...(dto.lowStockThreshold !== undefined
        ? { lowStockThreshold: dto.lowStockThreshold }
        : {}),
      ...(dto.trackStock !== undefined ? { trackStock: dto.trackStock } : {}),
      ...(dto.trackExpiry !== undefined
        ? { trackExpiry: dto.trackExpiry }
        : {}),
      ...(dto.active !== undefined ? { active: dto.active } : {}),
      ...(dto.imagePath !== undefined ? { imagePath: dto.imagePath } : {}),
    };

    if (dto.variants !== undefined) {
      data.variants = this.buildVariantReplaceSet(
        current.variants,
        dto.variants,
      );
    }

    if (Object.keys(data).length === 0) {
      return serializeProduct(current); // empty PATCH no-op
    }

    try {
      await this.scoped.product.update({ where: { id }, data });
    } catch (err) {
      mapCatalogWriteError(err);
    }
    // The choke point's update path drops include/select, so re-read the full
    // row (with its live variants) for the response.
    return serializeProduct(await this.loadOwned(id));
  }

  /**
   * DELETE: a product with sales history is ARCHIVED (`active = false`, kept), a
   * product without is soft-deleted (freeing its SKU/barcode). §6: never truly
   * deleted. Returns the resulting row either way.
   */
  async remove(id: string): Promise<ProductResponse> {
    const current = await this.loadOwned(id);
    const soldCount = await this.raw.saleItem.count({
      where: { productId: id, deletedAt: null },
    });
    if (soldCount > 0) {
      await this.scoped.product.update({
        where: { id },
        data: { active: false },
      });
      // Re-read (choke-point update drops include) — archived row stays live.
      return serializeProduct(await this.loadOwned(id));
    }
    const deleted = await this.scoped.product.delete({ where: { id } });
    return serializeProduct({ ...deleted, variants: current.variants });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private buildVariantReplaceSet(
    current: ProductVariant[],
    submitted: VariantInputDto[],
  ): Prisma.ProductUpdateInput['variants'] {
    const currentIds = new Set(current.map((v) => v.id));
    const unknown = submitted.find((v) => v.id && !currentIds.has(v.id));
    if (unknown) {
      throw new ValidationFailedError(`Unknown variant id "${unknown.id!}".`);
    }
    const withId = submitted.filter((v) => v.id);
    const submittedIds = new Set(withId.map((v) => v.id as string));
    if (withId.length !== submittedIds.size) {
      throw new ValidationFailedError(
        'The same variant id appears more than once in this submission.',
      );
    }
    const toCreate = submitted.filter((v) => !v.id);
    const toUpdate = submitted.filter((v) => v.id && currentIds.has(v.id));
    const toDelete = current.filter((v) => !submittedIds.has(v.id));

    return {
      ...(toCreate.length
        ? {
            create: toCreate.map((v) => ({
              name: v.name,
              sku: v.sku ?? null,
              barcode: v.barcode ?? null,
              price: v.priceC,
              cost: v.costC ?? null,
            })),
          }
        : {}),
      ...(toUpdate.length
        ? {
            update: toUpdate.map((v) => ({
              where: { id: v.id! },
              data: {
                name: v.name,
                sku: v.sku ?? null,
                barcode: v.barcode ?? null,
                price: v.priceC,
                cost: v.costC ?? null,
              },
            })),
          }
        : {}),
      // Nested delete is rewritten to a soft-delete by the choke point.
      ...(toDelete.length
        ? { delete: toDelete.map((v) => ({ id: v.id })) }
        : {}),
    };
  }

  /**
   * SKU/barcode must be unique across BOTH live products and live variants of the
   * business (separate namespaces). Checks the submission against itself and
   * against every other live product/variant. Excludes `excludeProductId` (and
   * thus its variants) on update, since its identifiers are being replaced.
   */
  private async assertUniqueIdentifiers(
    businessId: string,
    excludeProductId: string | null,
    skus: string[],
    barcodes: string[],
  ): Promise<void> {
    const dupSku = firstDuplicate(skus);
    if (dupSku) {
      throw new ValidationFailedError(
        `Duplicate SKU "${dupSku}" in this submission.`,
      );
    }
    const dupBarcode = firstDuplicate(barcodes);
    if (dupBarcode) {
      throw new ValidationFailedError(
        `Duplicate barcode "${dupBarcode}" in this submission.`,
      );
    }
    if (skus.length === 0 && barcodes.length === 0) return;

    const products = await this.scoped.product.findMany({
      where: {
        businessId,
        ...(excludeProductId ? { id: { not: excludeProductId } } : {}),
      },
      select: {
        sku: true,
        barcode: true,
        variants: { select: { sku: true, barcode: true } },
      },
    });

    const takenSku = new Set<string>();
    const takenBarcode = new Set<string>();
    for (const p of products) {
      if (p.sku) takenSku.add(p.sku);
      if (p.barcode) takenBarcode.add(p.barcode);
      for (const v of p.variants) {
        if (v.sku) takenSku.add(v.sku);
        if (v.barcode) takenBarcode.add(v.barcode);
      }
    }

    for (const s of skus) {
      if (takenSku.has(s)) {
        throw new ValidationFailedError(`SKU "${s}" is already in use.`);
      }
    }
    for (const b of barcodes) {
      if (takenBarcode.has(b)) {
        throw new ValidationFailedError(`Barcode "${b}" is already in use.`);
      }
    }
  }

  private async loadOwned(id: string): Promise<ProductWithVariants> {
    const product = await this.scoped.product.findFirst({
      where: { id },
      include: VARIANTS_INCLUDE,
    });
    if (!product) throw new NotFoundError('Product not found.');
    return product;
  }

  private async assertCategoryInBusiness(
    businessId: string,
    categoryId: string,
  ): Promise<void> {
    const cat = await this.scoped.category.findFirst({
      where: { id: categoryId, businessId },
      select: { id: true },
    });
    if (!cat) {
      throw new ValidationFailedError(
        'categoryId does not reference a category in this business.',
      );
    }
  }
}
