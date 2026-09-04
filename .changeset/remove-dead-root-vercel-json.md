---
"fabric-app": patch
---

Remove the unused repo-root vercel.json so the live Ignored Build Step policy in apps/web/vercel.json is the only one in the tree

The repo carried two `vercel.json` files with contradictory Ignored Build Step policies. Only `apps/web/vercel.json` is read: the single Vercel project linked to this repo has its Root Directory set to `apps/web`, and Vercel reads `vercel.json` from the Root Directory only, with no repo-root fallback. The root file dated from the initial public release commit and was referenced by nothing in `.github/`, `scripts/`, `turbo.json`, `.vercelignore` or any package manifest; every in-repo mention of `vercel.json` points at the `apps/web` one.

Behavioural confirmation that the root file was inert: `changeset-release/master` deployments come back CANCELED, which only rule 3 of `apps/web/scripts/vercel-ignore.sh` does. The root file's path filter would have built those commits, since a version bump touches `package.json` files outside its ignore list.

Why delete rather than annotate: `vercel.json` is strict JSON and cannot carry a comment pointing at the live file. Its two keys are both moot — `git.submodules: false` has nothing to act on (no `.gitmodules`), and its inline `ignoreCommand` is the stale policy. The in-repo Vercel CLI uses (`scripts/vercel-env-sync.sh` and `scripts/vercel-add-agent-vars.sh`) run `vercel env` commands against the linked project, which do not consult `vercel.json`; nothing in `.github/workflows` or the deployment tooling runs `vercel build` or `vercel deploy` from the repo root.

The trap this removes: a reader working out why a deployment did or did not build could land on the root file and conclude, wrongly, that `master` version-bump commits are skipped. The live policy says the opposite (`master` always builds, because the ops dev reconciler needs a promotable deployment at the exact admitted master tip).

Fizzy #2402.
