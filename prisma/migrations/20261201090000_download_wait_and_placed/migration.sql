-- AlterTable
ALTER TABLE "DownloadHandoff" ADD COLUMN "stashWaitSince" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DownloadDropIn" ADD COLUMN "placedAt" TIMESTAMP(3);
