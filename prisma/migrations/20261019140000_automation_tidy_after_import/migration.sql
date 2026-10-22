-- After a Whisparr import: rescan, remove extra copies and link waiting scenes.
ALTER TABLE "LibraryAutomationSettings" ADD COLUMN "tidyAfterImport" BOOLEAN NOT NULL DEFAULT true;
