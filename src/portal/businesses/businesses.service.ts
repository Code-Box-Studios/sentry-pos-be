import { Inject, Injectable } from '@nestjs/common';
import { Business } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SCOPED_PRISMA,
  type ScopedPrisma,
} from '../../prisma/scoped-prisma.provider';
import {
  getContext,
  runWithTxClient,
} from '../../common/context/request-context';
import {
  ForbiddenError,
  MaxBusinessesReachedError,
  NotFoundError,
} from '../../common/errors/api-errors';
import { CreateBusinessDto } from './dto/create-business.dto';
import { UpdateBusinessDto } from './dto/update-business.dto';

/** Business row with Decimal rates coerced to numbers for a clean JSON contract. */
export interface BusinessResponse extends Omit<
  Business,
  'taxRate' | 'serviceChargeRate'
> {
  taxRate: number;
  serviceChargeRate: number;
}

/** Prisma serializes Decimal as a string; the portal contract exposes numbers. */
export function serializeBusiness(b: Business): BusinessResponse {
  return {
    ...b,
    taxRate: b.taxRate.toNumber(),
    serviceChargeRate: b.serviceChargeRate.toNumber(),
  };
}

/**
 * Task 11 — portal business CRUD (tenant scope).
 *
 * All reads/writes flow through the ScopedPrisma choke point, which auto-filters
 * to the caller's owner, forces `ownerId` on create, soft-deletes, and writes
 * the mutation audit row — so this service never touches ownerId or auditing
 * directly. The one exception is the `maxBusinesses` cap, whose limit lives on
 * the Owner (a platform model, invisible in tenant scope), read via the raw
 * client.
 */
@Injectable()
export class BusinessesService {
  constructor(
    @Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma,
    private readonly raw: PrismaService,
  ) {}

  async list(): Promise<BusinessResponse[]> {
    const rows = await this.scoped.business.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(serializeBusiness);
  }

  async get(id: string): Promise<BusinessResponse> {
    const biz = await this.scoped.business.findFirst({ where: { id } });
    if (!biz) throw new NotFoundError('Business not found.');
    return serializeBusiness(biz);
  }

  async create(dto: CreateBusinessDto): Promise<BusinessResponse> {
    const { ownerId } = getContext();
    if (!ownerId) {
      throw new ForbiddenError('Portal access requires an owner account.');
    }

    // Enforce the maxBusinesses cap ATOMICALLY. A plain count→insert is a TOCTOU
    // race: two concurrent creates could both read count < max, then both insert.
    // Locking the owner row (FOR UPDATE) serializes creates for the same owner,
    // and running the insert on the SAME transaction via runWithTxClient (so the
    // choke point rides this tx rather than opening a nested one) keeps the count,
    // insert, and audit atomic. Demo businesses are excluded from the count; the
    // limit lives on the Owner (platform model), read here on the tx client.
    const biz = await this.raw.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM owners WHERE id = ${ownerId}::uuid FOR UPDATE`;
      const owner = await tx.owner.findUniqueOrThrow({
        where: { id: ownerId },
      });
      const count = await tx.business.count({
        where: { ownerId, isDemo: false, deletedAt: null },
      });
      if (count >= owner.maxBusinesses) {
        throw new MaxBusinessesReachedError();
      }
      // ownerId is passed to satisfy Prisma's create input; the choke point
      // re-forces it to the caller's owner regardless. isDemo stays false.
      return runWithTxClient(tx, () =>
        this.scoped.business.create({
          data: {
            ownerId,
            name: dto.name,
            type: dto.type,
            currency: dto.currency ?? 'PHP',
            taxRate: dto.taxRate,
            serviceChargeRate: dto.serviceChargeRate ?? 0,
            ...(dto.dayStartTime !== undefined
              ? { dayStartTime: dto.dayStartTime }
              : {}),
            ...(dto.allowMiscItems !== undefined
              ? { allowMiscItems: dto.allowMiscItems }
              : {}),
            ...(dto.expiryWarningDays !== undefined
              ? { expiryWarningDays: dto.expiryWarningDays }
              : {}),
            ...(dto.receiptHeader !== undefined
              ? { receiptHeader: dto.receiptHeader }
              : {}),
            ...(dto.receiptFooter !== undefined
              ? { receiptFooter: dto.receiptFooter }
              : {}),
          },
        }),
      );
    });
    return serializeBusiness(biz);
  }

  async update(id: string, dto: UpdateBusinessDto): Promise<BusinessResponse> {
    const existing = await this.get(id); // 404 if missing / not owned
    const data = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.type !== undefined ? { type: dto.type } : {}),
      ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
      ...(dto.taxRate !== undefined ? { taxRate: dto.taxRate } : {}),
      ...(dto.serviceChargeRate !== undefined
        ? { serviceChargeRate: dto.serviceChargeRate }
        : {}),
      ...(dto.dayStartTime !== undefined
        ? { dayStartTime: dto.dayStartTime }
        : {}),
      ...(dto.allowMiscItems !== undefined
        ? { allowMiscItems: dto.allowMiscItems }
        : {}),
      ...(dto.expiryWarningDays !== undefined
        ? { expiryWarningDays: dto.expiryWarningDays }
        : {}),
      ...(dto.receiptHeader !== undefined
        ? { receiptHeader: dto.receiptHeader }
        : {}),
      ...(dto.receiptFooter !== undefined
        ? { receiptFooter: dto.receiptFooter }
        : {}),
    };
    // An empty PATCH is a no-op: skip the write so the choke point doesn't emit
    // a spurious "before == after" audit row.
    if (Object.keys(data).length === 0) {
      return existing;
    }
    const biz = await this.scoped.business.update({ where: { id }, data });
    return serializeBusiness(biz);
  }

  /** Soft archive (§6 never truly deleted) — returns the archived row. */
  async remove(id: string): Promise<BusinessResponse> {
    await this.get(id); // 404 if missing / not owned
    const biz = await this.scoped.business.delete({ where: { id } });
    return serializeBusiness(biz);
  }
}
