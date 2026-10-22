-- Finished downloads: also bring in downloads added to Stashboard's SABnzbd
-- category by hand, once SABnzbd has finished them. On by default (the
-- category is Stashboard's own); only jobs finished after "sabManualSince"
-- are taken, so the existing history isn't swept.
ALTER TABLE "DownloadHandoffSettings" ADD COLUMN "sabManualJobs" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "DownloadHandoffSettings" ADD COLUMN "sabManualSince" TIMESTAMP(3);

-- Such downloads are followed like the ones Stashboard sends, without a
-- catalog scene: they're identified against the catalog once in Stash.
ALTER TABLE "DownloadHandoff" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'stashboard';
ALTER TABLE "DownloadHandoff" ALTER COLUMN "sceneId" DROP NOT NULL;
ALTER TABLE "DownloadHandoff" ALTER COLUMN "provider" DROP NOT NULL;
