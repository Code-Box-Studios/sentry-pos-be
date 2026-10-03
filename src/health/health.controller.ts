import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}
  @Get()
  check(): { ok: boolean } {
    return { ok: true };
  }
  @Get('ready')
  async ready(): Promise<{ ok: boolean }> {
    try {
      await this.prisma.$queryRaw`SELECT 1 AS ready`;
      return { ok: true };
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }
  }
}
