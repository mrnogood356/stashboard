-- CreateTable
CREATE TABLE "WatchLaterItem" (
    "stashSceneId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchLaterItem_pkey" PRIMARY KEY ("stashSceneId")
);

-- CreateIndex
CREATE INDEX "WatchLaterItem_position_idx" ON "WatchLaterItem"("position");
