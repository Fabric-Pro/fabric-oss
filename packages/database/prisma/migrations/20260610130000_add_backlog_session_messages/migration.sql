-- Capture the AI Update chat transcript on the session row so the read-only
-- Session history can show the conversation alongside the results. Nullable +
-- forward-only: existing sessions simply have no captured messages.
ALTER TABLE "backlog_update_session" ADD COLUMN "messages" JSONB;
