/*
  Warnings:

  - You are about to drop the column `payload` on the `notifications` table. All the data in the column will be lost.
  - Added the required column `body` to the `notifications` table without a default value. This is not possible if the table is not empty.
  - Added the required column `title` to the `notifications` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "notifications" DROP COLUMN "payload",
ADD COLUMN     "body" TEXT NOT NULL,
ADD COLUMN     "branch_id" UUID,
ADD COLUMN     "business_id" UUID,
ADD COLUMN     "entity_id" UUID,
ADD COLUMN     "title" TEXT NOT NULL;
