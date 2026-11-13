-- Run outside a transaction: time entries remain writable during the index
-- build. Unique: a suggestion is confirmed as at most one entry.
CREATE UNIQUE INDEX CONCURRENTLY "time_entry_sourceSuggestionId_key" ON "time_entry"("sourceSuggestionId");
