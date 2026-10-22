-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('DISCORD', 'NTFY', 'WEBHOOK');

-- CreateTable
CREATE TABLE "NotificationSettings" (
    "key" TEXT NOT NULL DEFAULT 'GLOBAL',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'DISCORD',
    "url" TEXT,
    "notifyDownloading" BOOLEAN NOT NULL DEFAULT false,
    "notifyAvailable" BOOLEAN NOT NULL DEFAULT true,
    "notifyFailed" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationSettings_pkey" PRIMARY KEY ("key")
);
