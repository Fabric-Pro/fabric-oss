#!/bin/sh
# Vercel "Ignored Build Step" for the web app (referenced by ignoreCommand in
# apps/web/vercel.json; runs with cwd = the project Root Directory, apps/web).
#
# Exit semantics (Vercel): exit 0 -> SKIP the build, exit 1 -> BUILD.
#
# Only the refs something deploys are built. Branch previews are not: in
# October 2026 they were 1,202 of this project's 2,085 builds and were rarely
# used, while CI already type-checks and tests every PR head.
#
# Decision ladder:
#  1. `master` and `staging` ALWAYS build for the exact-revision reconciler,
#     even when the diff touches nothing the web app uses.
#  2. `promotion/*` builds only for a trusted ops request. Automatic
#     `promotion/*` pushes, raw or versioned, skip. Ops requests a fresh
#     build on this staging project's Production target only when
#     deployment reuse fails, with a
#     deployment-scoped marker equal to the full Git commit SHA. This marker
#     admits a build; ops still owns deployment and QA authority.
#  3. Every other ref skips: feature and fix branches, Dependabot, the
#     Changesets Version PR (`changeset-release/*`) and its
#     `changesets-ghcommit-temp/*` staging ref, and the legacy `production`
#     ref.
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
exit 0
