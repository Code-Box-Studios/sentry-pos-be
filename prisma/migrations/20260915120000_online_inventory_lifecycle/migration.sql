-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "daily_summary_enabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "alert_key" TEXT,
ADD COLUMN     "resolved_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "owners" ADD COLUMN     "closed_at" TIMESTAMP(3),
ADD COLUMN     "purge_after" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "stock_batches" ADD COLUMN     "branch_id" UUID,
ADD COLUMN     "receive_movement_id" UUID;

-- AlterTable
ALTER TABLE "stock_counts" ADD COLUMN     "counted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "notes" TEXT;

-- CreateTable
CREATE TABLE "job_deliveries" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "job_key" TEXT NOT NULL,
    "business_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "claimed_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "job_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_deliveries_job_key_key" ON "job_deliveries"("job_key");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_alert_key_key" ON "notifications"("alert_key");

-- AddForeignKey
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

