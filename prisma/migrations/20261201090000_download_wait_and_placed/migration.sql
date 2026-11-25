-- AlterTable
ALTER TABLE "DownloadHandoff" ADD COLUMN "stashWaitSince" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DownloadDropIn" ADD COLUMN "placedAt" TIMESTAMP(3);

-- Drop-ins moved in before this: placed by their last update at the latest
-- (the real time isn't known), so an unchanged file left at the old path is
-- never taken for a new one. Only when files are moved, not copied: a copy
-- leaves its source where it was.
UPDATE "DownloadDropIn" SET "placedAt" = "updatedAt"
WHERE "finalPath" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "DownloadHandoffSettings" WHERE "importMode" = 'copy'
  );
