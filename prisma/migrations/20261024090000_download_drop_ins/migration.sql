-- Finished downloads: optionally bring in videos put straight into SABnzbd's category folder.
ALTER TABLE "DownloadHandoffSettings" ADD COLUMN "dropIns" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "DownloadDropIn" (
    "id" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'placed',
    "finalPath" TEXT,
    "stashSceneId" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DownloadDropIn_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DownloadDropIn_sourcePath_key" ON "DownloadDropIn"("sourcePath");

CREATE INDEX "DownloadDropIn_status_idx" ON "DownloadDropIn"("status");

CREATE INDEX "DownloadDropIn_createdAt_idx" ON "DownloadDropIn"("createdAt");
