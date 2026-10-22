-- Notice video files put straight into the library folders.
ALTER TABLE "LibraryAutomationSettings" ADD COLUMN "watchFolders" BOOLEAN NOT NULL DEFAULT true;
