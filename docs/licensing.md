# Licensing

Reflects the licensing decisions of 2026-07-29; the licensor entity is TechFabric LLC.

| Path | License |
|---|---|
| `/` (everything not listed below) | Apache-2.0 |
| `packages/cli`, `packages/sdk`, `packages/sdk-mcp`, `packages/integrations-*` | MIT |
| `docs/` | Apache-2.0 |
| `packages/integrations-runtime` | MIT, with Apache-2.0-derived Corsair material (see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)) |
| Fabric brand assets (logos, marks) | All rights reserved by TechFabric LLC; Apache-2.0 grants no trademark rights — see the trademark notice in `README.md` |

> Note: `packages/mcp-server` declares MIT and is `private: true`; it remains unpublished pending a publication decision.

## What ships inside a distributed artifact

Apache-2.0 §4(a) requires that every recipient of the Work or a Derivative Work receives a copy of the License, and §4(d) requires the NOTICE attributions to travel with it; MIT's condition has the same shape. A source checkout satisfies both by having the files at its root. An artifact does not, because its recipient never sees the tree — only what the build placed inside.

So each artifact carries its own copy:

| Artifact | Carries | How |
|---|---|---|
| Container images | `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md` at the image's app root | `COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./` in the final stage |
| npm packages | `LICENSE` | npm packs it into every tarball whatever the `files` array says |
| npm packages carrying third-party-derived material | additionally `LICENSE-APACHE-2.0` and a package-scoped `THIRD_PARTY_NOTICES.md` | named in the manifest's `files` array — npm packs nothing else it was not told about |

`THIRD_PARTY_NOTICES.md` travels with `NOTICE` because `NOTICE` points at it; shipping one without the other leaves the attribution dangling.

[`scripts/check-artifact-notices.ts`](../scripts/check-artifact-notices.ts) enforces this on every pull request. Every `Dockerfile` in the tree must copy the three files unless it is named in that script's `NOT_DISTRIBUTED` list together with the reason it is not published — a list that may shrink but never grow. Every publishable package must sit beside a `LICENSE`, and any notice file npm would not pack by itself must be named in `files`.

A new image or package is covered by default: the check requires the notices unless something is explicitly excused, rather than the other way round.

**What this does not cover yet.** Container images and npm packages are the two artifact kinds a release currently produces. A release does not yet attach a web or collaboration-server build artifact for anyone to download; when it does, that artifact is a distribution of the Work like any other and belongs under the same rule — extend the check with it rather than treating this section as complete. SBOMs and build attestations stay outside the rule on purpose: they describe an artifact rather than carry a copy of the Work, so there is nothing in them for the licence to travel with.
