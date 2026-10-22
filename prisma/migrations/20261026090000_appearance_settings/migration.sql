-- Settings → Appearance: theme, accent, corner radius, density, text size and custom CSS.
CREATE TABLE "AppearanceSettings" (
    "key" TEXT NOT NULL DEFAULT 'GLOBAL',
    "mode" TEXT NOT NULL DEFAULT 'system',
    "lightTheme" TEXT NOT NULL DEFAULT 'light',
    "darkTheme" TEXT NOT NULL DEFAULT 'dark',
    "accentColor" TEXT,
    "radius" TEXT NOT NULL DEFAULT 'default',
    "density" TEXT NOT NULL DEFAULT 'comfortable',
    "fontScale" TEXT NOT NULL DEFAULT 'default',
    "customCss" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppearanceSettings_pkey" PRIMARY KEY ("key")
);
