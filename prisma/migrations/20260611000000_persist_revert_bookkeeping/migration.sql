-- AlterTable
ALTER TABLE "ChangeLog" ADD COLUMN     "hidden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "undoneFields" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "RevertSuppression" (
    "storeId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "countExpiresAt" TIMESTAMP(3),
    "windowUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevertSuppression_pkey" PRIMARY KEY ("storeId","resourceId")
);
