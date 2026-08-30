-- AlterTable
ALTER TABLE "Feedback" ADD COLUMN "emailedAt" TIMESTAMP(3);

-- CreateIndex
-- Null emailedAt is the interesting case (never notified), so the index earns
-- its keep on exactly the query you run after a mail outage.
CREATE INDEX "Feedback_emailedAt_idx" ON "Feedback"("emailedAt");
