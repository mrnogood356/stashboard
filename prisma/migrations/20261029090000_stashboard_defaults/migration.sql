-- The default SABnzbd category for new installs follows the app's new name.
-- Saved settings keep whatever category they already use.
ALTER TABLE "DownloadHandoffSettings" ALTER COLUMN "category" SET DEFAULT 'stashboard';
