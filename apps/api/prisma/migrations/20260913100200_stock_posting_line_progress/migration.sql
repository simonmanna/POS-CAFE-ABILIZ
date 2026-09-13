-- Per-line progress for stock posting jobs. Each billed line (and each stock-
-- linked modifier/accompaniment) is issued in its own savepoint; the keys of the
-- lines already relieved are kept on the job so a retry after fixing the cause
-- issues only what is still missing — never a line twice.
ALTER TABLE "StockPostingJob" ADD COLUMN "postedLineKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
