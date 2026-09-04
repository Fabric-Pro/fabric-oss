---
"fabric-app": patch
---

Stop deploying the changesets staging ref, which spent an orphan full build on every master merge

The Vercel Ignored Build Step skipped `changeset-release/*` — the Version Packages PR branch, whose web content is identical to the master build already deployed — but the Version PR now reaches Vercel on two refs, not one.

Since the Changesets CLI v3 / action v2 migration the Version PR commit is made through the GitHub API by `@changesets/ghcommit`, which stages it on `changesets-ghcommit-temp/<target branch>` and only then updates `changeset-release/master`. Vercel deploys that staging push as a separate deployment: same commit sha as the `changeset-release/master` deployment beside it, no `githubPrId` so no preview link is posted anywhere, and the ref is deleted seconds later. Nothing consumed those builds. The skip rule never matched the prefix, so each one fell through to `turbo-ignore`, which saw a whole-master delta and built.

Confirmed against the 20 most recent deployments of the web project (a ~2.2h window on 4 Sep 2026): five master merges, and for each one a `changeset-release/master` deployment CANCELED by the existing rule paired with a `changesets-ghcommit-temp/changeset-release/master` deployment READY with a full turbopack build. Skipping it is safe — Vercel is not a required check on the public repo's master, and the identical skip has been live on `changeset-release/*` with no fallout.

Widens the rule to `changeset-release/*|changesets-ghcommit-temp/*` and names the staging ref in the script's comment, so the next changesets bump does not silently reopen it.

Also adds `apps/web/__tests__/scripts/vercel-ignore.test.ts`, which the script had been missing while both of its sibling scripts have one. It pins the ref ladder — the half of the decision that fails silently, since a ref that stops matching does not error, it just starts building. Only the rules that terminate before the script shells out are covered; leaving `VERCEL_GIT_PREVIOUS_SHA` unset keeps a fall-through case from reaching `git diff` or `turbo-ignore`. Verified as a real pin: against the pre-fix script exactly the two new cases fail and the other six pass.

Not verified: the "~6 Enhanced-machine minutes per merge, ~900+ min/month" figures carried in the script's own comment are inherited from the original rule and were not re-measured here, and whether `changesets-ghcommit-temp/` is stable across future changesets versions or incidental to the pinned one — hence the comment telling the next reader to keep the pattern in step.
