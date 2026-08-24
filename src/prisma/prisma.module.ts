import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { ScopedPrismaProvider, SCOPED_PRISMA } from './scoped-prisma.provider';

@Global()
@Module({
  providers: [PrismaService, ScopedPrismaProvider],
  exports: [PrismaService, SCOPED_PRISMA],
})
export class PrismaModule {}
