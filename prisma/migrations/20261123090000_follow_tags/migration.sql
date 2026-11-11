-- AlterTable
ALTER TABLE "Follow" ADD COLUMN     "fullyCheckedAt" TIMESTAMP(3),
ADD COLUMN     "reviewThrough" TEXT,
ADD COLUMN     "tags" JSONB NOT NULL DEFAULT '[]';
