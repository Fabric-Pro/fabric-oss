---
"fabric-app": patch
---

Show which organizations a feature flag is enrolled in or excluded from, on the instance feature-flag console

Fizzy #2348, FR4/UC2. Per-organization flag overrides were readable one
organization at a time and no other way: the control lives on
`admin/organizations/{id}`, so an operator holding a rollout had to remember who
was on it. The allowlist was real but had no list.

Each org-scopable flag on the instance console now carries `Enrolled: N ·
Excluded: M`, expanding to the organizations themselves with a link to each
one's page. Read-only — enrolment is still changed where it always was, so there
is no second write path and no new audit action.

Three things this deliberately gets right, because each is a way an operator
could act on a wrong reading:

- **Absent is not excluded.** An organization with no row inherits, appears in
  neither list and in neither count. The expanded panel says so in words; the
  counts alone cannot.
- **A failed read is not an empty allowlist.** The query has no `try`/`catch`
  and the panel renders the error rather than `0 · 0` — the same fail-loud
  stance as the sibling aggregates the daily sweep uses.
- **Counts are exact past the bound.** They come from a `groupBy` over the whole
  key, while the list stops at 100 rows. Truncation is detected by asking for one
  row more than the limit rather than by comparing the list against the counts —
  those are two statements, and a write landing between them would otherwise
  show as a phantom "and 1 more".

`admin.featureFlags.list` now answers `orgScopable` as a boolean on every flag.
The registry declares it as an optional `true`, so across the union of registry
entries the property does not exist at all, and a client deciding whether to
offer a per-organization control should not have to know that shape.

New: `getFlagEnrolment` in `@repo/database` and
`admin.featureFlags.organizations`. Sixteen tests, covering the empty, error,
truncated and mixed-state readings on all three layers.
