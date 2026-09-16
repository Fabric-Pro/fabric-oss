---
"fabric-app": patch
---

Slack huddle notes ingest now reports when a missing workspace permission has stopped it, instead of continuing to look like it is running.

A canvas that failed because the bot token lacked `files:read` / `canvases:read`
was logged, counted as skipped and dropped, so nothing reached the channel row
and the settings page could not explain why ingestion produced nothing. The
last-run timestamp advanced every interval regardless, so the feature read as
healthy indefinitely and only the worker logs disagreed.

The scope branch now matches the unreadable-channel branch beside it: the error
is recorded against the channel once per run, the canvas counts as failed rather
than skipped, and the last-run stamp is withheld while a scope is missing.
Transient per-canvas faults still stamp, since those clear on their own.

Withholding the stamp changes the workflow's command sequence, so it sits
behind its own `patched()` id: a history recorded before this landed scheduled
that activity unconditionally and continues to replay down the old path.
