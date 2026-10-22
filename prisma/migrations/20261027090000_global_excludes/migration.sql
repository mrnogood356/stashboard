-- Global exclude list: words, tags, studios and performers hidden from every catalog scene list.
CREATE TABLE "HiddenContentSettings" (
    "key" TEXT NOT NULL DEFAULT 'GLOBAL',
    "words" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" JSONB NOT NULL DEFAULT '[]',
    "studios" JSONB NOT NULL DEFAULT '[]',
    "performers" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HiddenContentSettings_pkey" PRIMARY KEY ("key")
);
