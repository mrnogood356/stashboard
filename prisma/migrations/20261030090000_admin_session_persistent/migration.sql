-- "Keep me signed in". Existing sessions were all long-lived, so they stay that way.
ALTER TABLE "AdminSession" ADD COLUMN "persistent" BOOLEAN NOT NULL DEFAULT true;
