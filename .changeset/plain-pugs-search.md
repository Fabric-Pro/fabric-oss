---
"fabric-app": patch
---

Topic Planning & Analysis now recommends LinkedIn as a content format of its own on already-deployed environments

The prompt seeded on 2026-08-30, before LINKEDIN_POST existed, and
`seed-prompts-only.ts` is INSERT-ONLY for a SYSTEM prompt that already exists —
so editing `PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY` reached fresh installs
and nothing else. Every deployed environment offered the LinkedIn tab while its
analysis worked from a list of content types that did not contain LinkedIn.
`20260909140000_sync_planning_analysis_linkedin_content_type` carries the two
changed paragraphs across, in the shape the four earlier `sync_*_prompt*`
migrations use: a `replace()` against the single PromptVersion the SYSTEM
default AGENT binding points at.

It declines to touch a prompt anyone has customised. An admin editing a SYSTEM
prompt goes through `createPromptVersion`, which inserts version N+1 and
cascades the binding onto it, so a customised prompt is exactly one carrying a
version above 1 — and the statement guards on that rather than on a record of
someone having checked. Verified against a real Postgres with the whole
migration chain applied: 1 row on a pristine seeded prompt (resulting content
byte-identical to the constant), 0 on a customised one whose v2 still carries
the old paragraph verbatim, 0 when a v2 exists but the binding was left pinned
to v1, 0 on a re-run, and an ORG fork holding the same old text left untouched.

The embedded text is a point-in-time snapshot, which the module it comes from
exists to avoid — a migration is frozen history and can never be re-synced. It
is pinned from the other end instead:
`__tests__/migrations/sync-planning-analysis-linkedin.test.ts` reads the two
dollar-quoted fragments out of the migration and fails if the constant stops
matching them, so a later reword has to decide whether it needs its own
migration. That alarm covers the paragraphs this migration touched, not the
rest of the body.
