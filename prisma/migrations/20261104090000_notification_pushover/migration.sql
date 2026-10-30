-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE 'PUSHOVER';

-- AlterTable
ALTER TABLE "NotificationSettings" ADD COLUMN "token" TEXT,
ADD COLUMN "userKey" TEXT;
