-- CreateTable
CREATE TABLE "DuplicateIgnore" (
    "sceneKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuplicateIgnore_pkey" PRIMARY KEY ("sceneKey")
);
