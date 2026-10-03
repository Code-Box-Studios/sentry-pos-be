import { HealthController } from './health.controller';
import type { PrismaService } from '../prisma/prisma.service';
describe('database readiness', () => {
  it('reports ready only after the database responds', async () => {
    const query = jest.fn().mockResolvedValue([{ ready: 1 }]);
    const controller = new HealthController({
      $queryRaw: query,
    } as unknown as PrismaService);
    await expect(controller.ready()).resolves.toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('returns unavailable without exposing connection details', async () => {
    const controller = new HealthController({
      $queryRaw: jest
        .fn()
        .mockRejectedValue(new Error('secret connection string')),
    } as unknown as PrismaService);
    await expect(controller.ready()).rejects.toThrow('Database unavailable');
  });
});
