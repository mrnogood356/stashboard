-- Downloads you clear from the list stay recorded, so they're never brought in twice.
ALTER TABLE "DownloadHandoff" ADD COLUMN "clearedAt" TIMESTAMP(3);
ALTER TABLE "DownloadDropIn" ADD COLUMN "clearedAt" TIMESTAMP(3);
