-- App Lock applies only to the app installed on a phone.
ALTER TABLE "AdminSession" ADD COLUMN "phoneApp" BOOLEAN NOT NULL DEFAULT false;
