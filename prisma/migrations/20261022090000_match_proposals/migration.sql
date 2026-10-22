-- Found matches waiting for you to check, kept through restarts.
CREATE TABLE "MatchProposal" (
    "sceneId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchProposal_pkey" PRIMARY KEY ("sceneId")
);
