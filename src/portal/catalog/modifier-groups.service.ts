import { Inject, Injectable } from '@nestjs/common';
import {
  Modifier,
  ModifierGroup,
  Prisma,
  ProductModifierGroup,
} from '@prisma/client';
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
import {
  CreateModifierGroupDto,
  ModifierInputDto,
} from './dto/create-modifier-group.dto';
import { UpdateModifierGroupDto } from './dto/update-modifier-group.dto';

type GroupWithModifiers = Prisma.ModifierGroupGetPayload<{
  include: { modifiers: true };
}>;

const MODIFIERS_INCLUDE = {
  modifiers: { orderBy: { createdAt: 'asc' as const } },
};

export interface ModifierResponse {
  id: string;
  groupId: string;
  name: string;
  priceDeltaC: number;
}

export interface ModifierGroupResponse {
  id: string;
  businessId: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  modifiers: ModifierResponse[];
}

export interface ProductGroupLinks {
  productId: string;
  groupIds: string[];
}

function serializeModifier(m: Modifier): ModifierResponse {
  return {
    id: m.id,
    groupId: m.groupId,
    name: m.name,
    priceDeltaC: m.priceDelta,
  };
}

function serializeGroup(
  g: ModifierGroup & { modifiers?: Modifier[] },
): ModifierGroupResponse {
  return {
    id: g.id,
    businessId: g.businessId,
    name: g.name,
    minSelect: g.minSelect,
    maxSelect: g.maxSelect,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    deletedAt: g.deletedAt,
    modifiers: (g.modifiers ?? []).map(serializeModifier),
  };
}

function assertMinMax(minSelect: number, maxSelect: number): void {
  if (minSelect > maxSelect) {
    throw new ValidationFailedError('minSelect must be ≤ maxSelect.');
  }
}

/**
 * Task 13 — modifier groups (+ nested modifiers) and product↔group links (tenant
 * scope). CRUD flows through the ScopedPrisma choke point (owner-scoping,
 * soft-delete, mutation audit incl. nested modifier writes). Modifier is a
 * child-only model, so modifiers are managed via nested replace-set writes.
 */
@Injectable()
export class ModifierGroupsService {
  constructor(
    @Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma,
    private readonly raw: PrismaService,
  ) {}

  async list(businessId: string): Promise<ModifierGroupResponse[]> {
    await assertBusinessOwned(this.scoped, businessId);
    const rows = await this.scoped.modifierGroup.findMany({
      where: { businessId },
      include: MODIFIERS_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(serializeGroup);
  }

  async create(
    businessId: string,
    dto: CreateModifierGroupDto,
  ): Promise<ModifierGroupResponse> {
    await assertBusinessOwned(this.scoped, businessId);
    assertMinMax(dto.minSelect ?? 0, dto.maxSelect ?? 1);
    const created = await this.scoped.modifierGroup.create({
      data: {
        businessId,
        name: dto.name,
        ...(dto.minSelect !== undefined ? { minSelect: dto.minSelect } : {}),
        ...(dto.maxSelect !== undefined ? { maxSelect: dto.maxSelect } : {}),
        modifiers: {
          create: (dto.modifiers ?? []).map((m) => ({
            name: m.name,
            priceDelta: m.priceDeltaC,
          })),
        },
      },
      include: MODIFIERS_INCLUDE,
    });
    return serializeGroup(created);
  }

  async update(
    id: string,
    dto: UpdateModifierGroupDto,
  ): Promise<ModifierGroupResponse> {
    const current = await this.loadOwnedGroup(id);
    assertMinMax(
      dto.minSelect ?? current.minSelect,
      dto.maxSelect ?? current.maxSelect,
    );

    const data: Prisma.ModifierGroupUpdateInput = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.minSelect !== undefined ? { minSelect: dto.minSelect } : {}),
      ...(dto.maxSelect !== undefined ? { maxSelect: dto.maxSelect } : {}),
    };
    if (dto.modifiers !== undefined) {
      data.modifiers = buildModifierReplaceSet(
        current.modifiers,
        dto.modifiers,
      );
    }
    if (Object.keys(data).length === 0) return serializeGroup(current);

    await this.scoped.modifierGroup.update({ where: { id }, data });
    // The choke point's update path drops include, so re-read for the response.
    return serializeGroup(await this.loadOwnedGroup(id));
  }

  /** Soft archive — returns the archived row. */
  async remove(id: string): Promise<ModifierGroupResponse> {
    const current = await this.loadOwnedGroup(id);
    const deleted = await this.scoped.modifierGroup.delete({ where: { id } });
    return serializeGroup({ ...deleted, modifiers: current.modifiers });
  }

  /**
   * Replace a product's modifier-group link set (`PUT groupIds`). Each groupId
   * must be a live modifier group of the product's own business. Because the
   * join carries a NON-partial `@@unique([productId, groupId])`, re-linking a
   * previously-removed group must RESTORE the soft-deleted row rather than insert
   * a duplicate. All writes ride the product's nested relation through the choke
   * point (ProductModifierGroup is child-only), so every link change also produces
   * the parent `product.update` audit row (nested creates/restores are covered by
   * that parent row; nested soft-deletes additionally get their own).
   */
  async setProductGroups(
    productId: string,
    groupIds: string[],
  ): Promise<ProductGroupLinks> {
    const product = await this.scoped.product.findFirst({
      where: { id: productId },
      select: { id: true, businessId: true },
    });
    if (!product) throw new NotFoundError('Product not found.');

    if (groupIds.length > 0) {
      const found = await this.scoped.modifierGroup.findMany({
        where: { id: { in: groupIds }, businessId: product.businessId },
        select: { id: true },
      });
      const foundIds = new Set(found.map((g) => g.id));
      const missing = groupIds.find((id) => !foundIds.has(id));
      if (missing) {
        throw new ValidationFailedError(
          `Modifier group "${missing}" does not exist in this business.`,
        );
      }
    }

    // Read via the RAW client: ProductModifierGroup is child-only (the scoped
    // client would throw on top-level access) and we need the soft-deleted rows
    // to restore them. Tenancy is already enforced above (product ownership +
    // groupId ∈ product's business), so this raw read is safe.
    const allLinks = await this.raw.productModifierGroup.findMany({
      where: { productId },
    });
    const nested = buildLinkReplaceSet(allLinks, groupIds);
    if (nested) {
      await this.scoped.product.update({
        where: { id: productId },
        data: { productModifierGroups: nested },
      });
    }

    const live = await this.raw.productModifierGroup.findMany({
      where: { productId, deletedAt: null },
      select: { groupId: true },
      orderBy: { createdAt: 'asc' },
    });
    return { productId, groupIds: live.map((l) => l.groupId) };
  }

  private async loadOwnedGroup(id: string): Promise<GroupWithModifiers> {
    const group = await this.scoped.modifierGroup.findFirst({
      where: { id },
      include: MODIFIERS_INCLUDE,
    });
    if (!group) throw new NotFoundError('Modifier group not found.');
    return group;
  }
}

function buildModifierReplaceSet(
  current: Modifier[],
  submitted: ModifierInputDto[],
): Prisma.ModifierGroupUpdateInput['modifiers'] {
  const currentIds = new Set(current.map((m) => m.id));
  const unknown = submitted.find((m) => m.id && !currentIds.has(m.id));
  if (unknown) {
    throw new ValidationFailedError(`Unknown modifier id "${unknown.id!}".`);
  }
  const withId = submitted.filter((m) => m.id);
  const submittedIds = new Set(withId.map((m) => m.id as string));
  if (withId.length !== submittedIds.size) {
    throw new ValidationFailedError(
      'The same modifier id appears more than once in this submission.',
    );
  }
  const toCreate = submitted.filter((m) => !m.id);
  const toUpdate = submitted.filter((m) => m.id && currentIds.has(m.id));
  const toDelete = current.filter((m) => !submittedIds.has(m.id));

  return {
    ...(toCreate.length
      ? {
          create: toCreate.map((m) => ({
            name: m.name,
            priceDelta: m.priceDeltaC,
          })),
        }
      : {}),
    ...(toUpdate.length
      ? {
          update: toUpdate.map((m) => ({
            where: { id: m.id! },
            data: { name: m.name, priceDelta: m.priceDeltaC },
          })),
        }
      : {}),
    ...(toDelete.length ? { delete: toDelete.map((m) => ({ id: m.id })) } : {}),
  };
}

/**
 * Diff the product's existing link rows (incl. soft-deleted) against the desired
 * group set: create truly-new links, RESTORE soft-deleted ones (deletedAt=null),
 * and soft-delete links no longer wanted. Returns null when nothing changes.
 */
function buildLinkReplaceSet(
  allLinks: ProductModifierGroup[],
  desired: string[],
): Prisma.ProductUpdateInput['productModifierGroups'] | null {
  const desiredSet = new Set(desired);
  const byGroup = new Map(allLinks.map((l) => [l.groupId, l]));

  const create: { group: { connect: { id: string } } }[] = [];
  const update: { where: { id: string }; data: { deletedAt: null } }[] = [];
  const del: { id: string }[] = [];

  for (const gid of desiredSet) {
    const link = byGroup.get(gid);
    if (!link) {
      create.push({ group: { connect: { id: gid } } });
    } else if (link.deletedAt !== null) {
      update.push({ where: { id: link.id }, data: { deletedAt: null } });
    }
    // live link already present → keep as-is
  }
  for (const link of allLinks) {
    if (link.deletedAt === null && !desiredSet.has(link.groupId)) {
      del.push({ id: link.id });
    }
  }

  if (!create.length && !update.length && !del.length) return null;
  return {
    ...(create.length ? { create } : {}),
    ...(update.length ? { update } : {}),
    ...(del.length ? { delete: del } : {}),
  };
}
