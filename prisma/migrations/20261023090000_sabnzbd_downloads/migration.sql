-- Finished downloads: SABnzbd as an optional integration, and the downloads sent to it.
ALTER TYPE "IntegrationType" ADD VALUE 'SABNZBD';

CREATE TABLE "DownloadHandoffSettings" (
    "key" TEXT NOT NULL DEFAULT 'GLOBAL',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "category" TEXT NOT NULL DEFAULT 'stasharr',
    "destination" TEXT,
    "sabPathFrom" TEXT,
    "sabPathTo" TEXT,
    "importMode" TEXT NOT NULL DEFAULT 'move',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DownloadHandoffSettings_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "DownloadHandoff" (
    "id" TEXT NOT NULL,
    "nzoId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "releaseTitle" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "sabPath" TEXT,
    "finalPath" TEXT,
    "stashSceneId" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DownloadHandoff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DownloadHandoff_nzoId_key" ON "DownloadHandoff"("nzoId");

CREATE INDEX "DownloadHandoff_status_idx" ON "DownloadHandoff"("status");

CREATE INDEX "DownloadHandoff_sceneId_idx" ON "DownloadHandoff"("sceneId");

CREATE INDEX "DownloadHandoff_createdAt_idx" ON "DownloadHandoff"("createdAt");
