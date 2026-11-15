-- CreateTable
CREATE TABLE "BrokenFileSkip" (
    "kind" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrokenFileSkip_pkey" PRIMARY KEY ("kind","sceneId")
);
