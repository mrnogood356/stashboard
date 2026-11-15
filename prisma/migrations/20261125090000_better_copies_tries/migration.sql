-- Better copies: every release grabbed for a scene, and how it ended.
CREATE TABLE "SmallerCopyTry" (
    "id" TEXT NOT NULL,
    "stashSceneId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "releaseGuid" TEXT,
    "releaseTitle" TEXT,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "oldSize" DOUBLE PRECISION,
    "newSize" DOUBLE PRECISION,
    "handoffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmallerCopyTry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SmallerCopyTry_handoffId_key" ON "SmallerCopyTry"("handoffId");
CREATE INDEX "SmallerCopyTry_stashSceneId_idx" ON "SmallerCopyTry"("stashSceneId");
CREATE INDEX "SmallerCopyTry_createdAt_idx" ON "SmallerCopyTry"("createdAt");

-- What's known so far: each scene's latest grab and how it ended.
INSERT INTO "SmallerCopyTry" ("id", "stashSceneId", "title", "releaseGuid", "releaseTitle", "outcome", "detail", "oldSize", "newSize", "handoffId", "createdAt", "updatedAt")
SELECT 'try_' || md5("stashSceneId"), "stashSceneId", "title", "releaseGuid", "releaseTitle", "outcome", "detail", "oldSize", "newSize", "handoffId", "searchedAt", "searchedAt"
FROM "SmallerCopyAttempt"
WHERE "outcome" IN ('grabbed', 'replaced', 'kept-both')
   OR ("outcome" = 'failed' AND "handoffId" IS NOT NULL);

-- Better copies downloads that failed are kept in its history above, so they
-- come off the Downloads list instead of waiting to be cleared by hand.
UPDATE "DownloadHandoff"
SET "clearedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'failed'
  AND "replacesStashSceneId" IS NOT NULL
  AND "finalPath" IS NULL
  AND "clearedAt" IS NULL;

-- A release whose download failed used to be freed to try again; it now stays
-- on the scene's grabbed list so it isn't grabbed a second time.
UPDATE "SmallerCopyAttempt"
SET "grabbedGuids" = array_append("grabbedGuids", "releaseGuid")
WHERE "outcome" = 'failed'
  AND "handoffId" IS NOT NULL
  AND "releaseGuid" IS NOT NULL
  AND NOT ("releaseGuid" = ANY("grabbedGuids"));
