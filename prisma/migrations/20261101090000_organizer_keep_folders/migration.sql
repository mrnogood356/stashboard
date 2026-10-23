-- Folders the empty-folder clean-up never removes (with everything inside
-- them), on top of Stash's library folders, Whisparr's root folders and the
-- Finished downloads destination, which are always kept.
ALTER TABLE "OrganizerSettings" ADD COLUMN "keepFolders" TEXT[] DEFAULT ARRAY[]::TEXT[];
