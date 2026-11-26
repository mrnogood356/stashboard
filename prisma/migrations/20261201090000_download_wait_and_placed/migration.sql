-- AlterTable
ALTER TABLE "DownloadHandoff" ADD COLUMN "stashWaitSince" TIMESTAMP(3);

-- AlterTable
-- Set from now on when a drop-in is moved in. Drop-ins from before are left
-- without it: whether each was moved or copied, and when, isn't recorded, so
-- they keep the old rule (same size at the same path is the same file).
ALTER TABLE "DownloadDropIn" ADD COLUMN "placedAt" TIMESTAMP(3);

-- AlterTable
-- Better copies' active hours are in your time zone (sent by the browser).
ALTER TABLE "SmallerCopySettings" ADD COLUMN "timeZone" TEXT;
