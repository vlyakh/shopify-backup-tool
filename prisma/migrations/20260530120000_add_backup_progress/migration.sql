-- AlterTable: live progress counter for in-progress backups
ALTER TABLE "Backup" ADD COLUMN "processedCount" INTEGER NOT NULL DEFAULT 0;
