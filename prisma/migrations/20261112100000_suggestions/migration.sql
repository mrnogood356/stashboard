-- "You may enjoy": scenes you said Not interested to, and its Home row.
CREATE TABLE "SuggestionDismissal" (
    "sceneId" TEXT NOT NULL,
    "reasonKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuggestionDismissal_pkey" PRIMARY KEY ("sceneId")
);

CREATE INDEX "SuggestionDismissal_reasonKey_idx" ON "SuggestionDismissal"("reasonKey");

ALTER TYPE "HomeRailKey" ADD VALUE 'YOU_MAY_ENJOY';
