-- Activity log: what Stasharr did, with Undo where it can.
CREATE TABLE "ActivityEntry" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'done',
    "count" INTEGER,
    "undo" JSONB,
    "undoneAt" TIMESTAMP(3),

    CONSTRAINT "ActivityEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ActivityEntry_createdAt_idx" ON "ActivityEntry"("createdAt");

CREATE INDEX "ActivityEntry_kind_createdAt_idx" ON "ActivityEntry"("kind", "createdAt");
