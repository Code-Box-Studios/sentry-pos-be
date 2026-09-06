/*
 * Proves the sale-seeding helper writes what the POS would write. Every
 * analytics e2e leans on it, so if this drifts from `sales.service.persist`
 * the reports would be validated against fiction.
 */
import { PrismaClient } from '@prisma/client';
import { resetDb, closeDb } from './helpers/db';
import { seedSale } from './helpers/sales';

const raw = new PrismaClient();

describe('seedSale helper (e2e)', () => {
  let branchId: string;
  let terminalId: string;

  beforeAll(async () => {
    await raw.$connect();
  });

  afterAll(async () => {
    await raw.$disconnect();
    await closeDb();
  });

  beforeEach(async () => {
    await resetDb();
    const owner = await raw.owner.create({
      data: { name: 'O', email: `o-${Date.now()}@t.com`, status: 'active' },
    });
    const business = await raw.business.create({
      data: { ownerId: owner.id, name: 'B', type: 'fnb', taxRate: '0.12' },
    });
    const branch = await raw.branch.create({
      data: { businessId: business.id, name: 'Main', code: 'MN', address: 'x' },
    });
    const terminal = await raw.terminal.create({
      data: { branchId: branch.id, name: 'T1', code: 'T1' },
    });
    branchId = branch.id;
    terminalId = terminal.id;
  });

  it('stores a subtotal that includes modifier prices', async () => {
    const sale = await seedSale(raw, {
      branchId,
      terminalId,
      createdAt: new Date('2026-03-02T04:00:00.000Z'),
      lines: [
        {
          qty: 2,
          unitPriceC: 10000,
          modifiers: [
            {
              groupId: 'g',
              modifierId: 'm',
              name: 'Oat milk',
              priceDeltaC: 2000,
            },
          ],
        },
      ],
    });

    // 2 x (100.00 + 20.00) = 240.00
    expect(sale.subtotal).toBe(24000);

    const stored = await raw.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(stored.subtotal).toBe(24000);

    // The stored unit_price is the BASE price — the modifier lives in the json.
    const [item] = await raw.saleItem.findMany({ where: { saleId: sale.id } });
    expect(item.unitPrice).toBe(10000);
    expect(item.modifiers).toEqual([
      { groupId: 'g', modifierId: 'm', name: 'Oat milk', priceDeltaC: 2000 },
    ]);
  });

  it('records a per-unit cost snapshot, and null when the cost is unset', async () => {
    const sale = await seedSale(raw, {
      branchId,
      terminalId,
      createdAt: new Date('2026-03-02T04:00:00.000Z'),
      lines: [
        { qty: 3, unitPriceC: 5000, costC: 2000 },
        { qty: 1, unitPriceC: 5000, costC: null },
      ],
    });

    const items = await raw.saleItem.findMany({
      where: { saleId: sale.id },
      orderBy: { qty: 'desc' },
    });
    expect(items[0].costSnapshot).toBe(2000);
    expect(items[1].costSnapshot).toBeNull();
  });

  it('writes a payment covering the total', async () => {
    const sale = await seedSale(raw, {
      branchId,
      terminalId,
      createdAt: new Date('2026-03-02T04:00:00.000Z'),
      paymentMethod: 'gcash',
      lines: [{ qty: 1, unitPriceC: 15000 }],
    });

    const [payment] = await raw.salePayment.findMany({
      where: { saleId: sale.id },
    });
    expect(payment.method).toBe('gcash');
    expect(payment.amount).toBe(sale.total);
  });

  it('can write a voided sale for the void/refund counts', async () => {
    const sale = await seedSale(raw, {
      branchId,
      terminalId,
      createdAt: new Date('2026-03-02T04:00:00.000Z'),
      status: 'voided',
      statusReason: 'Wrong order',
      lines: [{ qty: 1, unitPriceC: 5000 }],
    });

    const stored = await raw.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(stored.status).toBe('voided');
    expect(stored.statusReason).toBe('Wrong order');
  });
});
