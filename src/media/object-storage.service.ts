import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { assertTenantKey, prepareImage } from './image';

@Injectable()
export class ObjectStorageService {
  private readonly client: S3Client | null;
  private readonly bucket: string;
  constructor(config: ConfigService) {
    this.bucket = config.get<string>('TENANT_STORAGE_BUCKET') ?? '';
    const endpoint = config.get<string>('TENANT_STORAGE_ENDPOINT');
    const accessKeyId = config.get<string>('TENANT_STORAGE_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>(
      'TENANT_STORAGE_SECRET_ACCESS_KEY',
    );
    this.client =
      this.bucket && endpoint && accessKeyId && secretAccessKey
        ? new S3Client({
            endpoint,
            region:
              config.get<string>('TENANT_STORAGE_REGION') ?? 'ap-southeast-1',
            forcePathStyle: true,
            credentials: { accessKeyId, secretAccessKey },
          })
        : null;
  }
  get configured(): boolean {
    return this.client !== null;
  }
  async upload(
    businessId: string,
    kind: 'logo' | 'product',
    bytes: Buffer,
  ): Promise<string> {
    if (!this.client)
      throw new ServiceUnavailableException('Image storage is not configured.');
    const body = await prepareImage(bytes);
    const key = `${businessId}/${kind}/${randomUUID()}.webp`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'image/webp',
        CacheControl: 'private, max-age=3600',
      }),
    );
    return key;
  }
  async url(businessId: string, key: string | null): Promise<string | null> {
    if (!key || !this.client) return null;
    assertTenantKey(businessId, key);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: 3600 },
    );
  }
  async remove(businessId: string, key: string): Promise<void> {
    assertTenantKey(businessId, key);
    if (this.client)
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
  }
}
