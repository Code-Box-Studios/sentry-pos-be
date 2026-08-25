import { Inject, Injectable } from '@nestjs/common';
import { Discount } from '@prisma/client';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../prisma/scoped-prisma.provider';
import {
  NotFoundError,
  ValidationFailedError,
} from '../../common/errors/api-errors';
import { assertBusinessOwned } from '../shared/tenant-guards';
import { CreateDiscountDto } from './dto/create-discount.dto';
import { UpdateDiscountDto } from './dto/update-discount.dto';

/**
 * Task 13 — portal named discounts (tenant scope). CRUD through the ScopedPrisma
 * choke point (owner-scoping, soft-delete, mutation audit). `value` is a percent
 * (1–100) or centavos depending on `kind`; the percent range is enforced here
 * since class-validator can't express the conditional cleanly.
 */
@Injectable()
export class DiscountsService {
  constructor(@Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma) {}

  async list(businessId: string): Promise<Discount[]> {
    await assertBusinessOwned(this.scoped, businessId);
    return this.scoped.discount.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(businessId: string, dto: CreateDiscountDto): Promise<Discount> {
    await assertBusinessOwned(this.scoped, businessId);
    assertPercentRange(dto.kind, dto.value);
    return this.scoped.discount.create({
      data: {
        businessId,
        name: dto.name,
        kind: dto.kind,
        value: dto.value,
        appliesTo: dto.appliesTo,
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
    });
  }

  async get(id: string): Promise<Discount> {
    const discount = await this.scoped.discount.findFirst({ where: { id } });
    if (!discount) throw new NotFoundError('Discount not found.');
    return discount;
  }

  async update(id: string, dto: UpdateDiscountDto): Promise<Discount> {
    const existing = await this.get(id);
    // Validate the RESULTING kind/value so a PATCH can't leave a percent out of range.
    assertPercentRange(dto.kind ?? existing.kind, dto.value ?? existing.value);
    const data = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
      ...(dto.value !== undefined ? { value: dto.value } : {}),
      ...(dto.appliesTo !== undefined ? { appliesTo: dto.appliesTo } : {}),
      ...(dto.active !== undefined ? { active: dto.active } : {}),
    };
    if (Object.keys(data).length === 0) return existing;
    return this.scoped.discount.update({ where: { id }, data });
  }

  /** Soft archive — returns the archived row. */
  async remove(id: string): Promise<Discount> {
    await this.get(id);
    return this.scoped.discount.delete({ where: { id } });
  }
}

function assertPercentRange(kind: string, value: number): void {
  if (kind === 'percent' && (value < 1 || value > 100)) {
    throw new ValidationFailedError(
      'A percent discount value must be between 1 and 100.',
    );
  }
}
