---
"fabric-app": patch
---

Draft a case study from a publishing topic, and keep its unapproved claims generalized rather than asserted

Fizzy #1854, Phase 2C slice 1. Activates the Case Study generation tab on the Topic
Item Page. Stakeholder Email follows in slice 2 and still reads "Coming soon".

No migration. Phase 2B built the draft tables generic over all four post types on
purpose — `PublishingTopicPostType` already carried `CASE_STUDY`, and every writer in
`publishing-drafts.ts` is post-type agnostic — so this is a prompt, an activity, a
workflow, three procedures and a panel.

## Why a case study needed more than a copy of the blog post

It is the approval-sensitive format, and two of its safeguards are new rather than
mirrored:

- **A wider restriction set.** The shared predicate treats five decision kinds as
  restricting. That is right for a tweet and wrong here: an open "is this claim strong
  enough?" question is exactly what must constrain a case study. `CLAIM_STRENGTH`,
  `AUDIENCE_SCOPE` and `CODEBASE_DETAIL` now restrict this type only — additive, so no
  Tweet or Blog Post behaviour changes.
- **Two clause blocks, not one.** The existing block is subject-shaped ("NOT approved
  for use — leave it out"), which is incoherent for a question. Rendering "Audience
  scope" under it would instruct the model to strip the audience framing. Open
  questions get their own block: unsettled, do not resolve by assumption.

`customerIdentity` and `metricsBasis` are the model's claim, so the server clamps them
downward from the topic's own open approval threads — `APPROVED` to `APPROVAL_NEEDED`,
`CONFIRMED` to `PLACEHOLDER`, and only those transitions. `ANONYMIZED` and
`QUALITATIVE` are terminal safe states: clamping them would tell an author their
correctly-generalized draft is blocked on an approval it does not need, and would erase
the only signal distinguishing a model that complied from one that ignored the clause.
The clamp is rendered on the panel, not merely recorded.

Source material reaches the prompt inside labelled untrusted-data markers with a locked
clause saying instructions never come from inside them. A PR description is not
authored by Fabric.

## Deploy step this needs

The prompt seed is insert-only and **no workflow in this repository runs it**. Until
someone runs `pnpm --filter @repo/database seed:prompts`, generation falls back to the
built-in default body and records `promptSource: DEFAULT_UNBOUND`, so it works but the
prompt is not editable in the Prompt Library.

## Fixed in passing

- `resolveContributorNames` had three byte-identical copies across the publishing
  activities; this would have made four. Extracted to one.
- `blog-post.ts` claimed its duplicated body composer was "pinned by a test asserting
  both produce the same text". No such test existed — the copies agreed by coincidence
  between two hardcoded literals. The test now exists, and the comment's other false
  half (that the API package does not depend on `@repo/temporal`, which its
  `package.json` declares) is corrected. The 2C families share one composer instead.
- The prompt-action catalog had no test for the Blog Post agent at all. Backfilled.
- All three locked-clause builders in the family rendered a thread subject into
  a bullet list having only trimmed it. Those bullets sit OUTSIDE the
  source-data fence, inside the rules section itself, so a newline in a subject
  did not wrap a bullet - it opened a line at column zero among the rules that
  override everything above them, with no marker to forge and no fence to
  defeat. Subjects are now folded onto one line before rendering, in the two
  shipped 2B builders as well as the new one. Reported by an automated reviewer
  on this PR.

## Known defect, reported not fixed

A project-scoped guest passes `requireProjectPermission` — an active `ProjectMember`
row is authoritative — but the Temporal activity rechecks organization membership
instead, so their generation always fails after the draft row exists. The converse
leaks too: someone demoted mid-run still passes. This is live for Tweet and Blog Post
today and is not introduced here. Fixing it needs the effective-permission resolver
moved below the API package, which no publishing activity can import.
