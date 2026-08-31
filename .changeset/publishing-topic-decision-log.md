---
"fabric-app": patch
---

Publishing Suite: answer a topic's AI-raised planning questions and review every decision in a filterable Decision Log

Phase 2A-3 of the Topic Item Page (Fizzy #1851). The Planning & Analysis
worksheet from 2A-2 already surfaced the decisions a topic needs settled, but
they were read-only. Each open question is now backed by its own row on a new
decision thread: an editor can answer it inline from the Summary & Questions
tab (typed in, accepted from the AI's own recommendation, or accepted with
edits), and the Decision Log tab lists every question and its answer for the
topic, filterable to All, Open, or Resolved.

**Reconciliation, not re-creation, is the point.** Regenerating the planning
analysis does not throw the old questions away and mint a fresh batch — it
walks the new analysis against the topic's existing thread. A question still
open gets its wording refreshed in place. One already answered is left alone,
so a second pass never re-asks something the user already settled. One that
was soft-closed because an earlier analysis stopped raising it, and now
reappears, is reactivated rather than replacing it with a new, unrelated
row. And one the new analysis no longer raises at all is soft-closed. A
short AI Update note records what changed, written during reconciliation
itself — inside the same transaction that flips the analysis to READY.

Reconciliation runs **inside the same transaction** that flips the analysis
to READY, not as a follow-up step afterward. That makes "a ready analysis has
a reconciled thread" an invariant rather than a sequence a crash partway
through can leave half-finished.

**Deploy, two steps, both required:** run the migration for the new decision
thread table, then `pnpm --filter @repo/database apply:rls` — its row-level
security policy is defined in `apply-rls-direct.ts`, not the migration
itself, so skipping the second step leaves the table unprotected.
