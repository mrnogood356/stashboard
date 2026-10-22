-- Delete sample clips that came with an import.
ALTER TABLE "LibraryAutomationSettings" ADD COLUMN "removeSamples" BOOLEAN NOT NULL DEFAULT false;
