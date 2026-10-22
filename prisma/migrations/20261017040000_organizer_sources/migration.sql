-- AlterTable
ALTER TABLE "OrganizerSettings" ADD COLUMN "useStashScrapers" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "tpdbApiKey" TEXT;
