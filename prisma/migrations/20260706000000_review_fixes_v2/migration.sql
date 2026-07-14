-- AlterTable
ALTER TABLE "ChangeLog" ADD COLUMN     "webhookEventId" TEXT;

-- AlterTable
ALTER TABLE "RevertSuppression" ADD COLUMN     "armedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "uninstalledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "webhookId" TEXT;

-- CreateIndex
CREATE INDEX "ChangeLog_storeId_resourceId_idx" ON "ChangeLog"("storeId", "resourceId");

-- CreateIndex
CREATE INDEX "ChangeLog_webhookEventId_idx" ON "ChangeLog"("webhookEventId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_webhookId_key" ON "WebhookEvent"("webhookId");
