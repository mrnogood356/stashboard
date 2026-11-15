-- A scene whose Better copies download failed now looks for another release
-- on the next search. Those that failed before this waited up to a day: due
-- now too. The failed releases stay skipped.
UPDATE "SmallerCopyAttempt"
SET "retryAfter" = CURRENT_TIMESTAMP
WHERE "outcome" = 'failed'
  AND "retryAfter" > CURRENT_TIMESTAMP;
