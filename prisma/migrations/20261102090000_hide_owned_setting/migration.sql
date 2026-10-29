-- Settings → Hidden: leave scenes already in your library out of catalog lists.
ALTER TABLE "HiddenContentSettings" ADD COLUMN "hideOwned" BOOLEAN NOT NULL DEFAULT false;
