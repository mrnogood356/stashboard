-- Failed Better copies downloads whose file had already come in were left out
-- of the tried list by the backfill before this one: added now. They stay on
-- the Downloads list to look at.
INSERT INTO "SmallerCopyTry" ("id", "stashSceneId", "title", "releaseTitle", "outcome", "detail", "handoffId", "createdAt", "updatedAt")
SELECT 'try_h_' || md5(h."id"), h."replacesStashSceneId",
       COALESCE(a."title", h."releaseTitle"), h."releaseTitle", 'failed',
       LEFT('The file came in but couldn’t be put on the scene: ' || COALESCE(h."error", 'no reason given'), 300),
       h."id", h."createdAt", h."updatedAt"
FROM "DownloadHandoff" h
LEFT JOIN "SmallerCopyAttempt" a ON a."stashSceneId" = h."replacesStashSceneId"
WHERE h."status" = 'failed'
  AND h."replacesStashSceneId" IS NOT NULL
  AND h."finalPath" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "SmallerCopyTry" t WHERE t."handoffId" = h."id");
