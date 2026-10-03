import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
export interface MediaCleanupObject {
  businessId: string;
  key: string;
}
/** Persist before losing the last database reference to an object. The system
 * cleanup worker deletes idempotently and retains this manifest on failures. */
export async function queueMediaCleanup(
  client: Pick<Prisma.TransactionClient, 'jobDelivery'>,
  objects: MediaCleanupObject[],
  jobKey = `media-cleanup:${randomUUID()}`,
): Promise<void> {
  if (objects.length === 0) return;
  const payload = {
    objects: objects.map((o) => ({ businessId: o.businessId, key: o.key })),
  };
  await client.jobDelivery.upsert({
    where: { jobKey },
    create: { jobKey, status: 'pending', payload },
    update: { payload },
  });
}
