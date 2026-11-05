-- CreateTable
CREATE TABLE "HealthSample" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "service" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "ms" INTEGER,
    "error" TEXT,

    CONSTRAINT "HealthSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HealthSample_service_at_idx" ON "HealthSample"("service", "at");

-- CreateIndex
CREATE INDEX "HealthSample_at_idx" ON "HealthSample"("at");
