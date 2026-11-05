-- CreateTable
CREATE TABLE "AppVersionState" (
    "key" TEXT NOT NULL DEFAULT 'GLOBAL',
    "lastVersion" TEXT NOT NULL,
    "previousVersion" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppVersionState_pkey" PRIMARY KEY ("key")
);
