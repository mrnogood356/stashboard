-- Settings → Playback: turn the built-in player, swipe feed and card previews on or off.
CREATE TABLE "PlaybackSettings" (
    "key" TEXT NOT NULL DEFAULT 'GLOBAL',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "feedEnabled" BOOLEAN NOT NULL DEFAULT true,
    "previewsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaybackSettings_pkey" PRIMARY KEY ("key")
);
