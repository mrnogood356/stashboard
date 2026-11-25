-- AlterTable
ALTER TABLE "DownloadHandoff" ADD COLUMN "rematchTriedAt" TIMESTAMP(3),
ADD COLUMN "placePending" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "DownloadDropIn" ADD COLUMN "rematchTriedAt" TIMESTAMP(3),
ADD COLUMN "placePending" BOOLEAN NOT NULL DEFAULT false;
