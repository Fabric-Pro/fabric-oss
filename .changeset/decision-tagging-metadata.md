---
"fabric-app": patch
---

Decisions can now be tagged with a type from a per-project AI-recommended taxonomy, an accountable owner, a long-standing/short-term duration, and a Priority flag that feeds roadmap prioritization.

Fizzy #2029 (core tagging increment). What shipped:

- New `DecisionType` per-project taxonomy table + RLS policy; types are minted by human entry or save-time resolution of an AI-suggested label, so discarded suggestions never fragment the taxonomy.
- `architecture_decision` gains `decisionTypeId`, `ownerUserId`, `duration` (LONG_STANDING | SHORT_TERM), `priorityFlagged(+At)`; all nullable/defaulted so existing rows stay valid. Version snapshots record the same metadata; revert restores it.
- Decisions form: Classification section with type select (+ inline new label), owner picker (must be a project member), duration select, Priority toggle, and an AI "Suggest metadata" action backed by a new `suggestMetadata` procedure (feature key `decision-tagging`). Table and detail sheet render the tags; owner chip shows on the sheet.
- Meeting-decision conversion now auto-applies suggested tags best-effort at capture time.
- Saving or editing an owned decision notifies its owner (new DECISION_OWNER_ASSIGNED / DECISION_OWNER_UPDATED notification types; routed through the "assignments" preference toggle).
- Roadmap reprioritization prompt: decision guidance lines carry duration/Priority tags, Priority-flagged decisions sort first.

Deferred follow-ups on the card: automated backfill of historical decisions, role-based auto-routing of owners (blocked on roles/tags), taxonomy re-clustering cadence, approval gating.

Tests: decision-type ensure/dedup unit tests, suggestion post-processing tests, guidance-ordering test, RLS coverage guard extended for `decision_type`.
