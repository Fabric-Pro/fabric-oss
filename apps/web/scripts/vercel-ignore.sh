#!/bin/sh
# Vercel "Ignored Build Step" for the web app (referenced by ignoreCommand in
# apps/web/vercel.json; runs with cwd = the project Root Directory, apps/web).
#
# Exit semantics (Vercel): exit 0 -> SKIP the build, exit 1 -> BUILD.
# Every failure path here exits 1 (fail open to building).
#
# Decision ladder:
#  1. Preserve the legacy guard: a ref literally named "production" never
#     builds (carried over from the old dashboard Ignored Build Step).
#  2. `master` ALWAYS builds. The ops dev reconciler promotes the staging
#     domain to the production deployment whose commit sha equals the
#     admitted master tip exactly — by policy it never falls back to an
#     older commit — so a skipped master commit (e.g. a version-bump-only
#     release commit whose whole diff is inert paths under rule 5) has no
#     promotable deployment, ever, and every reconcile cycle fails until
#     the tip moves. Master commits are relayed squashes that already
#     passed CI, so the skip rules below save little there anyway; the
#     savings cases (previews, the Version PR refs) keep them.
#  3. The bot-managed Version PR never builds (not even its first
#     deployment), on EITHER of the two refs it reaches Vercel on:
#       - `changeset-release/*` — the auto-generated Version Packages PR
#         (master + version-string bumps, web content identical to the
#         already-deployed master build). It is force-pushed after EVERY
#         master merge, so its diff vs the previous deployment spans whole
#         master deltas and turbo-ignore would always build it: ~6 wasted
#         Enhanced-machine minutes per merge, observed ~900+ min/month.
#       - `changesets-ghcommit-temp/*` — since the Changesets CLI v3 /
#         action v2 migration the Version PR commit is made through the
#         GitHub API by @changesets/ghcommit, which stages it on
#         `changesets-ghcommit-temp/<target branch>` and only then updates
#         the real branch. Vercel deploys that staging push too, as a
#         SEPARATE deployment of the same sha: it carries no `githubPrId`,
#         so no preview link is posted anywhere, and the ref is deleted
#         seconds later — nothing ever consumes it. Keep this pattern in
#         step with the changesets version: a renamed staging prefix
#         silently reopens one orphan full build per master merge, which is
#         exactly how it went unnoticed after that migration.
#     Precedent: changeset-check.yml and dco.yml special-case the Version
#     PR branch the same way. If a preview is ever genuinely wanted there,
#     use the dashboard Redeploy button.
#  4. The FIRST deployment of any remaining ref always builds —
#     turbo-ignore's HEAD^ fallback only sees the last commit of a
#     multi-commit push, so skipping without a previous-deployment
#     baseline could drop a preview that contains web changes.
#  5. Diffs made ONLY of inert root-level paths skip directly. Turborepo
#     attributes files outside any workspace package to the root package and
#     conservatively treats that as affecting EVERY package, so turbo-ignore
#     alone would always build for .changeset/.github/docs-only pushes. The
#     list mirrors the changeset-check workflow's no-impact paths, minus the
#     blanket *.md rule (markdown inside apps/web is site content), plus the
#     fabric-app version-bump files (deploy meta-package; its bumps don't
#     affect the web build).
#  6. Everything else: turbo-ignore decides from the turbo graph whether
#     @repo/web or anything it depends on changed since the last successful
#     deployment of this branch (errors fail open to building).
[ "$VERCEL_GIT_COMMIT_REF" = "production" ] && exit 0
[ "$VERCEL_GIT_COMMIT_REF" = "master" ] && exit 1
case "$VERCEL_GIT_COMMIT_REF" in changeset-release/*|changesets-ghcommit-temp/*) exit 0 ;; esac
[ -z "$VERCEL_GIT_PREVIOUS_SHA" ] && exit 1
CHANGED=$(git diff --name-only "$VERCEL_GIT_PREVIOUS_SHA" HEAD) || exit 1
[ -z "$CHANGED" ] && exit 1
echo "$CHANGED" | grep -qvE '^(\.changeset/|\.github/|docs/|\.vscode/|\.claude/|\.cursor/|\.augment/|README\.md$|\.gitignore$|LICENSE$|packages/fabric-app/(CHANGELOG\.md|package\.json)$)' || exit 0
exec npx turbo-ignore@2
