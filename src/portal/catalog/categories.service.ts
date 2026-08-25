import { Inject, Injectable } from '@nestjs/common';
import { Category } from '@prisma/client';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../prisma/scoped-prisma.provider';
import { NotFoundError } from '../../common/errors/api-errors';
import { assertBusinessOwned } from '../shared/tenant-guards';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

/**
 * Task 12 — portal category CRUD (tenant scope). All access flows through the
 * ScopedPrisma choke point (owner-scoping, businessId create-policing,
 * soft-delete, mutation audit). Categories carry no uniqueness constraint.
 */
@Injectable()
export class CategoriesService {
  constructor(@Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma) {}

  async list(businessId: string): Promise<Category[]> {
    await assertBusinessOwned(this.scoped, businessId);
    return this.scoped.category.findMany({
      where: { businessId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(businessId: string, dto: CreateCategoryDto): Promise<Category> {
    await assertBusinessOwned(this.scoped, businessId);
    return this.scoped.category.create({
      data: {
        businessId,
        name: dto.name,
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
  }

  async get(id: string): Promise<Category> {
    const cat = await this.scoped.category.findFirst({ where: { id } });
    if (!cat) throw new NotFoundError('Category not found.');
    return cat;
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<Category> {
    const existing = await this.get(id); // 404 if missing / not owned
    const data = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
    };
    if (Object.keys(data).length === 0) return existing;
    return this.scoped.category.update({ where: { id }, data });
  }

  /** Soft archive — returns the archived row. */
  async remove(id: string): Promise<Category> {
    await this.get(id); // 404 if missing / not owned
    return this.scoped.category.delete({ where: { id } });
  }
}
