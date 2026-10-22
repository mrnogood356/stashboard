-- CreateTable
CREATE TABLE "LibraryAutomationSettings" (
    "key" TEXT NOT NULL DEFAULT 'GLOBAL',
    "scanOnImport" BOOLEAN NOT NULL DEFAULT true,
    "identifyNew" BOOLEAN NOT NULL DEFAULT true,
    "generateNew" BOOLEAN NOT NULL DEFAULT true,
    "webhookToken" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" TEXT,
    "lastRunMessage" TEXT,
    "lastRunReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryAutomationSettings_pkey" PRIMARY KEY ("key")
);
