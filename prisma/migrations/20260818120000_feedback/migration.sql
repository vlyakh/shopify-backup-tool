-- CreateEnum
CREATE TYPE "FeedbackKind" AS ENUM ('PROBLEM', 'REQUEST', 'OTHER');

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "kind" "FeedbackKind" NOT NULL DEFAULT 'OTHER',
    "message" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Feedback_storeId_createdAt_idx" ON "Feedback"("storeId", "createdAt");
