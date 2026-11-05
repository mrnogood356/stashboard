-- AlterTable
ALTER TABLE "DownloadHandoff" ADD COLUMN "replacesStashSceneId" TEXT;

-- CreateTable
CREATE TABLE "SmallerCopySettings" (
    "key" TEXT NOT NULL DEFAULT 'GLOBAL',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "targetResolution" TEXT NOT NULL DEFAULT '1080p',
    "replaceHigher" BOOLEAN NOT NULL DEFAULT true,
    "upgradeLower" BOOLEAN NOT NULL DEFAULT false,
    "maxFileSizeGb" DOUBLE PRECISION,
    "minFileSizeGb" DOUBLE PRECISION,
    "maxNewSizeGb" DOUBLE PRECISION,
    "minSavingsPercent" INTEGER NOT NULL DEFAULT 10,
    "codec" TEXT NOT NULL DEFAULT 'any',
    "prefer" TEXT NOT NULL DEFAULT 'largest',
    "matchStrength" TEXT NOT NULL DEFAULT 'strong',
    "studioMode" TEXT NOT NULL DEFAULT 'all',
    "studioNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "autoGrab" BOOLEAN NOT NULL DEFAULT true,
    "oldCopy" TEXT NOT NULL DEFAULT 'delete',
    "scenesPerHour" INTEGER NOT NULL DEFAULT 10,
    "activeFromHour" INTEGER,
    "activeToHour" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmallerCopySettings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SmallerCopyAttempt" (
    "stashSceneId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "releaseGuid" TEXT,
    "indexerId" INTEGER,
    "detail" TEXT,
    "releaseTitle" TEXT,
    "oldSize" DOUBLE PRECISION,
    "newSize" DOUBLE PRECISION,
    "handoffId" TEXT,
    "searchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retryAfter" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmallerCopyAttempt_pkey" PRIMARY KEY ("stashSceneId")
);

-- CreateIndex
CREATE INDEX "SmallerCopyAttempt_searchedAt_idx" ON "SmallerCopyAttempt"("searchedAt");

-- CreateIndex
CREATE INDEX "SmallerCopyAttempt_retryAfter_idx" ON "SmallerCopyAttempt"("retryAfter");
