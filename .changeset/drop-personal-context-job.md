---
"fabric-app": patch
---

Add the personal-context drop job

The 2026-08-25 ruling was to drop personal-workspace data rather than migrate it. This is the job, and each of the audit's migration hazards is what shapes a phase of it — because each is also a way a naive delete goes wrong.

A purchase row carries the payment provider's customer and subscription identifiers, so deleting it removes our record and nothing else while the subscription keeps billing. Cancellation is a separate flag from `--apply`, and a user with a live subscription is refused rather than dropped until someone chooses.

Files are keyed by tenant — a personal object lives under its owner's user id — so dropping rows without objects would leave the user's content in the bucket after every trace of it left the database. Personal embeddings share one collection with every other user's, so they come out by filter rather than by dropping a collection. Two tables encode personal as an empty string rather than null, and a sweep written against `IS NULL` misses them silently.

`audit_log` is append-only under a trigger that permits DELETE only with a session variable set in the same transaction, and permits no UPDATE at all — which is why dropping the audit trail is possible where re-tenanting it was not.

Dry run by default, per user so one failure isolates rather than ending the run, and idempotent. A phase that cannot complete leaves that user untouched and says why: a drop that reports success while content survives is worse than one that stops, because nobody goes back to check.

It lives at the repository root rather than in the database package, which depends on neither the payment provider nor the vector store, deliberately.
