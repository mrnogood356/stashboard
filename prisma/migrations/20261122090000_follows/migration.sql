-- CreateEnum
CREATE TYPE "FollowKind" AS ENUM ('PERFORMER', 'STUDIO');

-- CreateEnum
CREATE TYPE "FollowedSceneState" AS ENUM ('NEW', 'REQUESTED', 'DISMISSED', 'FAILED');

-- AlterEnum
ALTER TYPE "HomeRailKey" ADD VALUE 'FOLLOWING';

-- AlterTable
ALTER TABLE "NotificationSettings" ADD COLUMN     "notifyFollowed" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "Follow" (
    "id" TEXT NOT NULL,
    "kind" "FollowKind" NOT NULL,
    "provider" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT,
    "since" TEXT NOT NULL,
    "autoRequest" BOOLEAN NOT NULL DEFAULT false,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowedScene" (
    "followId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "imageUrl" TEXT,
    "studioId" TEXT,
    "studioName" TEXT,
    "releaseDate" TEXT,
    "duration" INTEGER,
    "state" "FollowedSceneState" NOT NULL DEFAULT 'NEW',
    "detail" TEXT,
    "foundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowedScene_pkey" PRIMARY KEY ("followId","sceneId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Follow_provider_kind_entityId_key" ON "Follow"("provider", "kind", "entityId");

-- CreateIndex
CREATE INDEX "FollowedScene_sceneId_idx" ON "FollowedScene"("sceneId");

-- CreateIndex
CREATE INDEX "FollowedScene_state_foundAt_idx" ON "FollowedScene"("state", "foundAt");

-- AddForeignKey
ALTER TABLE "FollowedScene" ADD CONSTRAINT "FollowedScene_followId_fkey" FOREIGN KEY ("followId") REFERENCES "Follow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

