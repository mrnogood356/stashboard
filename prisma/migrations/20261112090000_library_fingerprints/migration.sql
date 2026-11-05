-- File fingerprints of each library scene, to spot a scene you have on a
-- second catalog (FansDB next to StashDB) that Stash hasn't linked there.
ALTER TABLE "LibrarySceneIndex" ADD COLUMN "fingerprints" TEXT[] DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "LibrarySceneIndex_fingerprints_idx" ON "LibrarySceneIndex" USING GIN ("fingerprints");
