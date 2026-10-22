-- AlterTable
ALTER TABLE "OrganizerSettings" ADD COLUMN "sendToWhisparr" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "addToWhisparr" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "whisparrImportMode" TEXT NOT NULL DEFAULT 'move',
ADD COLUMN "whisparrPathFrom" TEXT,
ADD COLUMN "whisparrPathTo" TEXT;
