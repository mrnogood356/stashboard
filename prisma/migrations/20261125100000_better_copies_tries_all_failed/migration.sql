-- Every failed Better copies download in the tried list, including those the
-- first backfill missed because a later search moved the scene's row on, so
-- each one taken off the Downloads list is still listed in Tried.
INSERT INTO "SmallerCopyTry" ("id", "stashSceneId", "title", "releaseTitle", "outcome", "detail", "handoffId", "createdAt", "updatedAt")
SELECT 'try_h_' || md5(h."id"), h."replacesStashSceneId",
       COALESCE(a."title", h."releaseTitle"), h."releaseTitle", 'failed',
       LEFT('The download failed: ' || COALESCE(h."error", 'no reason given'), 300),
       h."id", h."createdAt", h."updatedAt"
FROM "DownloadHandoff" h
LEFT JOIN "SmallerCopyAttempt" a ON a."stashSceneId" = h."replacesStashSceneId"
WHERE h."status" = 'failed'
  AND h."replacesStashSceneId" IS NOT NULL
  AND h."finalPath" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "SmallerCopyTry" t WHERE t."handoffId" = h."id");
