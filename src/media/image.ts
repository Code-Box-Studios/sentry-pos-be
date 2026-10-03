import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function assertTenantKey(businessId: string, key: string): void {
  const parts = key.split('/');
  if (
    parts.length !== 3 ||
    parts[0] !== businessId ||
    !['logo', 'product'].includes(parts[1]) ||
    !/^[0-9a-f-]{36}\.webp$/.test(parts[2])
  ) {
    throw new BadRequestException('Invalid tenant image key.');
  }
}

export async function prepareImage(bytes: Buffer): Promise<Buffer> {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new BadRequestException('Image must be at most 4 MB.');
  try {
    const image = sharp(bytes, {
      limitInputPixels: 25_000_000,
      animated: false,
    });
    const meta = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(meta.format ?? ''))
      throw new Error('unsupported');
    return await image
      .rotate()
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw new BadRequestException('Upload a valid JPEG, PNG or WebP image.');
  }
}
