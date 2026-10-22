-- Settings → Logs: the log level and log files, changeable while running.
CREATE TABLE "LogSettings" (
    "key" TEXT NOT NULL DEFAULT 'GLOBAL',
    "level" TEXT NOT NULL DEFAULT 'info',
    "fileEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LogSettings_pkey" PRIMARY KEY ("key")
);
