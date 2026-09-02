---
"fabric-app": patch
---

Saving any Testing setting no longer silently drops the UX Skeptic role from a project that had never configured one.

Found while verifying the coverage-target split (Fizzy #2186) on staging: a partial settings update came back with `scepticRoles: []`. Two layers disagreed about the default. `QA_SETTINGS_DEFAULTS.scepticRoles` is `["ux"]` — what an unconfigured project reads, so the page shows UX Skeptic enabled — while the Prisma column defaulted to `[]`. `upsertProjectQaSettings` takes its create branch on a project with no saved row, Prisma fills every omitted column from the column default, and the persona the split deliberately keeps on disappeared the first time somebody saved an unrelated field.

The column default now matches the constant, and `qa-settings-defaults-parity.test.ts` parses `schema.prisma` to assert every QA-settings default agrees across both layers — lists and scalars — so a future edit to one side fails CI rather than shipping a silent behaviour change. Verified red before the fix and green after. The migration alters only the DEFAULT: existing rows are untouched, so a project that genuinely chose an empty set keeps it and nobody's disabled persona is re-enabled.
