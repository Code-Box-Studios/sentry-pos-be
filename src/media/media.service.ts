import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { SCOPED_PRISMA } from '../prisma/scoped-prisma.provider';
import type { ScopedPrisma } from '../prisma/scoped-prisma.provider';
import { NotFoundError } from '../common/errors/api-errors';
import { ObjectStorageService } from './object-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { runWithTxClient } from '../common/context/request-context';
import { queueMediaCleanup } from './media-cleanup';

@Injectable()
export class MediaService {
  private readonly log = new Logger(MediaService.name);
  constructor(
    @Inject(SCOPED_PRISMA) private readonly scoped: ScopedPrisma,
    private readonly storage: ObjectStorageService,
    private readonly raw: PrismaService,
  ) {}
  async image(
    kind: 'logo' | 'product',
    id: string,
    upload?: Buffer,
    remove = false,
  ) {
    const row =
      kind === 'logo'
        ? await this.scoped.business.findFirst({ where: { id } })
        : await this.scoped.product.findFirst({ where: { id } });
    if (!row) throw new NotFoundError('Image owner not found.');
    const businessId = 'businessId' in row ? row.businessId : row.id;
    let oldKey = 'logoPath' in row ? row.logoPath : row.imagePath;
    let key = oldKey;
    if (upload !== undefined || remove) {
      if (upload !== undefined && !upload.length)
        throw new BadRequestException('Choose an image.');
      key = remove
        ? null
        : await this.storage.upload(businessId, kind, upload!);
      try {
        await this.raw.$transaction((tx) =>
          runWithTxClient(tx, async () => {
            // Serialize pointer swaps; the replaced key must come from the locked
            // row, otherwise concurrent uploads leave the losing upload orphaned.
            if (kind === 'logo')
              await tx.$queryRaw`SELECT id FROM businesses WHERE id=${id}::uuid FOR UPDATE`;
            else
              await tx.$queryRaw`SELECT id FROM products WHERE id=${id}::uuid FOR UPDATE`;
            const current =
              kind === 'logo'
                ? await this.scoped.business.findFirst({ where: { id } })
                : await this.scoped.product.findFirst({ where: { id } });
            if (!current) throw new NotFoundError('Image owner not found.');
            oldKey =
              'logoPath' in current ? current.logoPath : current.imagePath;
            if (oldKey && oldKey !== key)
              await queueMediaCleanup(tx, [{ businessId, key: oldKey }]);
            if (kind === 'logo')
              await this.scoped.business.update({
                where: { id },
                data: { logoPath: key },
              });
            else
              await this.scoped.product.update({
                where: { id },
                data: { imagePath: key },
              });
          }),
        );
      } catch (error) {
        if (key) await queueMediaCleanup(this.raw, [{ businessId, key }]);
        if (key)
          await this.storage
            .remove(businessId, key)
            .catch(() =>
              this.log.warn('Could not clean up an unreferenced image.'),
            );
        throw error;
      }
      if (oldKey && oldKey !== key)
        await this.storage
          .remove(businessId, oldKey)
          .catch(() => this.log.warn('Could not remove a replaced image.'));
    }
    return {
      url: await this.storage.url(businessId, key),
      configured: this.storage.configured,
      expiresIn: 3600,
    };
  }
}
