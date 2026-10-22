-- StashDB scenes that are the same as another (merged, or matched by hand).
CREATE TABLE "SceneStashAlias" (
    "stashId" TEXT NOT NULL,
    "aliasOf" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SceneStashAlias_pkey" PRIMARY KEY ("stashId")
);

CREATE INDEX "SceneStashAlias_aliasOf_idx" ON "SceneStashAlias"("aliasOf");
