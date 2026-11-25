-- AlterTable
ALTER TABLE "DownloadHandoff" ADD COLUMN "stashWaitSince" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DownloadDropIn" ADD COLUMN "placedAt" TIMESTAMP(3);

-- Drop-ins moved in before this: placed by their last update at the latest,
-- so an unchanged file left at the old path is never taken for a new one.
UPDATE "DownloadDropIn" SET "placedAt" = "updatedAt" WHERE "finalPath" IS NOT NULL;
