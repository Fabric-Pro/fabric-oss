---
"fabric-app": patch
---

Make the question-assignment flag a runtime toggle instead of an env var, so turning it on no longer needs a redeploy.

Fizzy #1751 follow-up. `QUESTION_ASSIGNMENT` is now registered in
`FEATURE_FLAG_REGISTRY` and read through `isFeatureEnabled`, so it is flippable
from the admin console with the usual override-row > env-var > default
precedence. The env var stays as the seed for a fresh environment.

It shipped as a bare `process.env` read, which meant every rollout step — and the
kill switch — was a code change plus a deploy. That is the exact failure mode the
registry exists to prevent, and matching the older `process.env` flags next to it
in `feature-flag.ts` was the wrong call.

The `NEXT_PUBLIC_` client mirror is **deleted rather than migrated**. It is
inlined at build time, so a DB override could never move it and the kill switch
would stay behind a redeploy no matter what the server did. The flag is now
resolved once, server-side, in `getEditorState`, and the client reads no flag at
all — the absence of `questionAssignees` from the payload is what hides every
control.

That makes the payload's `null` load-bearing and distinct from `{}`: `null` means
the feature is off, `{}` means it is on with nobody assigned yet. Collapsing them
would render an empty picker on every question with the feature disabled, so a
test pins the distinction and was confirmed to fail when the two are merged.

Turning the flag off leaves existing assignment rows untouched — they are simply
never read — so flipping it back on restores them exactly.
