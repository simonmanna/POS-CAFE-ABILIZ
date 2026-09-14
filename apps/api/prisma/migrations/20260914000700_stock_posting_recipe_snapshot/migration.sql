ALTER TABLE "StockPostingJob" ADD COLUMN "recipeSnapshot" JSONB;

COMMENT ON COLUMN "StockPostingJob"."recipeSnapshot" IS
'Immutable menu/combo component snapshot captured when the posting job is enqueued.';
