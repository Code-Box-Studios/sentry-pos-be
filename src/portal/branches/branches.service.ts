import { Inject, Injectable } from '@nestjs/common';
import { Branch, Prisma } from '@prisma/client';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../prisma/scoped-prisma.provider';
import {
  NotFoundError,
  ValidationFailedError,
} from '../../common/errors/api-errors';
import { assertBusinessOwned } from '../shared/tenant-guards';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';

/**
 * Map a branch write error to an API error. The `@@unique([businessId, code])`
 * constraint surfaces as Prisma P2002 — a client input problem, so it becomes a
 * 422 rather than an unhandled 500. Anything else is rethrown unchanged.
 */
function mapBranchWriteError(err: unknown): never {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002'
  ) {
    throw new ValidationFailedError(
      'A branch with this code already exists for this business.',
    );
  }
  throw err;
}

/**
 * Task 11 — portal branch CRUD (tenant scope). All access goes through the
 * ScopedPrisma choke point (auto owner-scoping, businessId create-policing,
 * soft-delete, mutation audit). Branches are addressed either under their parent
 * business (list/create) or directly by id (get/patch/delete).
 */
@Injectable()
export class BranchesService {
  constructor(@Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma) {}

  async list(businessId: string): Promise<Branch[]> {
    await assertBusinessOwned(this.scoped, businessId);
    return this.scoped.branch.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(businessId: string, dto: CreateBranchDto): Promise<Branch> {
    await assertBusinessOwned(this.scoped, businessId);
    try {
      return await this.scoped.branch.create({
        data: {
          businessId,
          name: dto.name,
          code: dto.code,
          address: dto.address,
        },
      });
    } catch (err) {
      mapBranchWriteError(err);
    }
  }

  async get(id: string): Promise<Branch> {
    const branch = await this.scoped.branch.findFirst({ where: { id } });
    if (!branch) throw new NotFoundError('Branch not found.');
    return branch;
  }

  async update(id: string, dto: UpdateBranchDto): Promise<Branch> {
    const existing = await this.get(id); // 404 if missing / not owned
    const data = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.code !== undefined ? { code: dto.code } : {}),
      ...(dto.address !== undefined ? { address: dto.address } : {}),
    };
    // An empty PATCH is a no-op: skip the write (no spurious audit row).
    if (Object.keys(data).length === 0) {
      return existing;
    }
    try {
      return await this.scoped.branch.update({ where: { id }, data });
    } catch (err) {
      mapBranchWriteError(err);
    }
  }

  /** Soft archive — returns the archived row. */
  async remove(id: string): Promise<Branch> {
    await this.get(id); // 404 if missing / not owned
    return this.scoped.branch.delete({ where: { id } });
  }
}
