import sharp from 'sharp';
import { prepareImage, assertTenantKey } from './image';

describe('tenant image boundary', () => {
  it('rejects another business key, traversal, and external URLs', () => {
    for (const key of [
      'other/logo/a.webp',
      'biz/../other/a.webp',
      'https://host/a',
      'biz/logo/a.svg',
    ]) {
      expect(() => assertTenantKey('biz', key)).toThrow();
    }
    expect(() =>
      assertTenantKey(
        'biz',
        'biz/logo/550e8400-e29b-41d4-a716-446655440000.webp',
      ),
    ).not.toThrow();
  });
  it('rejects SVG and disguised non-images', async () => {
    await expect(
      prepareImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).rejects.toThrow();
    await expect(prepareImage(Buffer.from('not an image'))).rejects.toThrow();
  });
  it('decodes and normalizes a valid raster instead of trusting the extension', async () => {
    const input = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    const result = await prepareImage(input);
    expect((await sharp(result).metadata()).format).toBe('webp');
  });
  it('rejects oversized uploads before decoding', async () => {
    await expect(
      prepareImage(Buffer.alloc(4 * 1024 * 1024 + 1)),
    ).rejects.toThrow();
  });
});
