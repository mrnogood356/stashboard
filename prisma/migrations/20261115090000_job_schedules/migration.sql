-- CreateTable
CREATE TABLE "JobSchedule" (
    "job" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "hour" INTEGER NOT NULL DEFAULT 4,
    "minute" INTEGER NOT NULL DEFAULT 0,
    "days" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobSchedule_pkey" PRIMARY KEY ("job")
);
