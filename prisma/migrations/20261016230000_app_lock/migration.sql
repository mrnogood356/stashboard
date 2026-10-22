-- AlterTable
ALTER TABLE "AdminSession" ADD COLUMN "lockedAt" TIMESTAMP(3),
ADD COLUMN "lastActiveAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AppLock" (
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "pinHash" TEXT,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 60,
    "hideInSwitcher" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppLock_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "AppLockPasskey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "AppLockPasskey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppLockPasskey_credentialId_key" ON "AppLockPasskey"("credentialId");

-- CreateIndex
CREATE INDEX "AppLockPasskey_userId_idx" ON "AppLockPasskey"("userId");

-- AddForeignKey
ALTER TABLE "AppLock" ADD CONSTRAINT "AppLock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppLockPasskey" ADD CONSTRAINT "AppLockPasskey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
