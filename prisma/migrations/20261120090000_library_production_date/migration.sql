-- AlterTable
ALTER TABLE "LibrarySceneIndex" ADD COLUMN     "height" INTEGER,
ADD COLUMN     "productionDate" TEXT,
ADD COLUMN     "width" INTEGER;

-- CreateIndex
CREATE INDEX "LibrarySceneIndex_productionDate_idx" ON "LibrarySceneIndex"("productionDate");
