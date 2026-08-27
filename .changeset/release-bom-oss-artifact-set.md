---
"fabric-app": patch
---

Rework the release BOM around attested container snapshots and a credential-free collab-worker artifact, and emit release-manifest schema 2.0.0.

The release BOM could not be assembled in the canonical product repository as
seeded. `release-bom.yml` waited on four artifact workflows that do not exist
there, resolved the 13 container digests from cloud registries the repository
has (and must never have) no federation with, and bound its `collect` job to
the `Production` deployment environment purely for that federation. This
replaces the whole input side.

Producer set. `oss-snapshot-images.yml` and the new `release-artifacts.yml`
replace `build-migration-runner.yml`, `deploy-azure-container-apps.yml`,
`deploy-vercel-prod.yml` and `deploy-partykit-prod.yml`.

Run selection. The two producers are started by different refs — the snapshot
matrix by the `master` push of the release commit, `release-artifacts.yml` by
the tag push — so the branch a producer's run must carry is now resolved per
producer rather than assumed to be the tag. Both selectors move together: the
waiter and the final pre-publication re-check. Changing only one yields
`PRODUCER GONE` against a perfectly healthy producer, and the release stays a
draft forever.

Digest collection. The ACR collector and its cloud login are gone. `collect`
now calls the repository's existing snapshot verifier, which polls for all 14
exact-SHA snapshots and verifies both the provenance and the SPDX attestation
from the registry, and builds the manifest rows from that verified evidence.
The job holds no deployment credential of any kind and no longer binds an
environment.

New workflow `release-artifacts.yml`. Tag-triggered, guarded to the canonical
repository, and secretless: it builds the collab worker with
`wrangler deploy --dry-run --outdir`, tars the bundle together with
`wrangler.toml`, attests the tarball and uploads it with 90-day retention. All
three wrangler flags were confirmed present on the pinned major.

Schema 2.0.0. All 14 container rows are uniform — `registryRole:
ghcr-snapshot`, a full `reference`, verified provenance and SBOM, and a
`deployTarget` naming the repository path the deployer imports into (absent on
`migration-runner`, which is executed as a job rather than rolled out). The
two platform rows split by kind: `collab-worker` becomes a `platform-artifact`
with a real digest and verified provenance; `web` becomes a `platform-source`
with `digest: null` and an explicit `digestUnavailableReason`, because Next.js
inlines the production platform environment at build time and that environment
lives with the deployer, so this repository produces nothing content-addressed
to digest. A fabricated digest would make the manifest lie about what it can
prove.

Publish gate. `check_platform` splits into `check_platform_artifact` and
`check_platform_source`; the provenance and SBOM assertions that applied to
`migration-runner` alone now apply to all 14 images, together with
`reference` and `deployTarget` shape checks. The expected component set is
unchanged — `web` and `collab-worker` are still required — which is the
invariant that must not weaken. Verified against a simulated manifest: the
gate passes a well-formed one and fails closed on 15 separate mutations,
including a `platform-source` row that quietly acquires a digest.

The nine publishable package manifests now point `repository.url` at the
canonical repository, which npm requires to match the publishing repo.
