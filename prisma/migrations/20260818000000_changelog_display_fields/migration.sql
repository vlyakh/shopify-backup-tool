-- AlterTable
ALTER TABLE "ChangeLog" ADD COLUMN     "displayFields" TEXT[] DEFAULT ARRAY[]::TEXT[];
