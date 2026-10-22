-- CreateTable
CREATE TABLE "OrganizerSettings" (
    "key" TEXT NOT NULL DEFAULT 'GLOBAL',
    "renamePattern" TEXT NOT NULL DEFAULT '{studio}/{date} - {title}',
    "renameAfterMatch" BOOLEAN NOT NULL DEFAULT false,
    "skipWhisparrFiles" BOOLEAN NOT NULL DEFAULT true,
    "autoMatchNightly" BOOLEAN NOT NULL DEFAULT false,
    "lastRunKind" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" TEXT,
    "lastRunMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizerSettings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "OrganizerRename" (
    "id" SERIAL NOT NULL,
    "batchId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "fromPath" TEXT NOT NULL,
    "toPath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),

    CONSTRAINT "OrganizerRename_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizerRename_batchId_idx" ON "OrganizerRename"("batchId");

-- CreateIndex
CREATE INDEX "OrganizerRename_createdAt_idx" ON "OrganizerRename"("createdAt");
