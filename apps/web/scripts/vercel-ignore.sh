#!/bin/sh
# Vercel "Ignored Build Step" for the web app (referenced by ignoreCommand in
# apps/web/vercel.json; runs with cwd = the project Root Directory, apps/web).
#
# Exit semantics (Vercel): exit 0 -> SKIP the build, exit 1 -> BUILD.
# Ordinary preview detection failures exit 1 (fail open to building).
# Promotion refs require an exact marker, otherwise they skip.
#
# Decision ladder:
#  1. Preserve the legacy guard: a ref literally named "production" never
#     builds (carried over from the old dashboard Ignored Build Step).
#  2. `master` and `staging` ALWAYS build for the exact-revision reconciler.
#     Automatic `promotion/*` previews skip, including versioned pushes.
#     Trusted ops requests a fresh Preview only when deployment reuse fails,
#     with a deployment-scoped marker equal to the full Git commit SHA.
#     This marker admits a build; ops still owns deployment and QA authority.
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
case "$VERCEL_GIT_COMMIT_REF" in master|staging) exit 1 ;; esac
case "$VERCEL_GIT_COMMIT_REF" in
  promotion/*)
    case "$FABRIC_PRIVATE_PROMOTION_BUILD_SHA" in
      ''|*[!0-9a-f]*) exit 0 ;;
    esac
    [ "${#FABRIC_PRIVATE_PROMOTION_BUILD_SHA}" -eq 40 ] \
      && [ "$FABRIC_PRIVATE_PROMOTION_BUILD_SHA" = "$VERCEL_GIT_COMMIT_SHA" ] && exit 1
    exit 0
    ;;
esac
case "$VERCEL_GIT_COMMIT_REF" in changeset-release/*|changesets-ghcommit-temp/*) exit 0 ;; esac
[ -z "$VERCEL_GIT_PREVIOUS_SHA" ] && exit 1
CHANGED=$(git diff --name-only "$VERCEL_GIT_PREVIOUS_SHA" HEAD) || exit 1
[ -z "$CHANGED" ] && exit 1
echo "$CHANGED" | grep -qvE '^(\.changeset/|\.github/|docs/|\.vscode/|\.claude/|\.cursor/|\.augment/|README\.md$|\.gitignore$|LICENSE$|packages/fabric-app/(CHANGELOG\.md|package\.json)$)' || exit 0
exec npx turbo-ignore@2
