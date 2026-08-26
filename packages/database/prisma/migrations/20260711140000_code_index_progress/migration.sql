-- Live indexing progress: track files embedded so far and the run's total so the
-- Settings UI can render a determinate progress bar while a repo is INDEXING.
-- Both nullable — populated per embed batch, reset at the start of a fresh run,
-- and meaningless once the run finishes (the final stats live in filesIndexed).
ALTER TABLE "project_code_index" ADD COLUMN "indexedFileCount" INTEGER;
ALTER TABLE "project_code_index" ADD COLUMN "totalFileCount" INTEGER;
