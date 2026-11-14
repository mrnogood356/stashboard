-- Better copies: size rules are per hour of video, and the new copy gets a floor.
-- Saved values carry over as they were (now read as GB an hour).
ALTER TABLE "SmallerCopySettings" RENAME COLUMN "maxFileSizeGb" TO "maxGbPerHour";
ALTER TABLE "SmallerCopySettings" RENAME COLUMN "minFileSizeGb" TO "minGbPerHour";
ALTER TABLE "SmallerCopySettings" RENAME COLUMN "maxNewSizeGb" TO "maxNewGbPerHour";
ALTER TABLE "SmallerCopySettings" ADD COLUMN "minNewGbPerHour" DOUBLE PRECISION;

-- New setups start safe: matches wait for you, and both files are kept.
ALTER TABLE "SmallerCopySettings" ALTER COLUMN "autoGrab" SET DEFAULT false;
ALTER TABLE "SmallerCopySettings" ALTER COLUMN "oldCopy" SET DEFAULT 'keep';
