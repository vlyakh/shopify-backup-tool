-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "pendingRetentionDays" INTEGER,
ADD COLUMN     "pendingRetentionAt" TIMESTAMP(3);
