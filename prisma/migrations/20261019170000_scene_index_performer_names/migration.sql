-- Performer names on indexed scenes, so Acquisition can search by performer.
ALTER TABLE "SceneIndex" ADD COLUMN "performerNames" TEXT;

-- Refresh the details of scenes still waiting soon, so their performers fill in.
UPDATE "SceneIndex"
SET "metadataLastSyncedAt" = TIMESTAMP '2000-01-01 00:00:00'
WHERE "metadataHydrationState" = 'HYDRATED'
  AND "computedLifecycle" IN ('REQUESTED', 'DOWNLOADING', 'IMPORT_PENDING', 'FAILED');
