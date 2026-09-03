# Release BOM — the draft-release publish gate

A release is published only after its **bill of materials** exists and checks out. This page is
for the moment you find a release sitting on `/releases` marked **Draft** and need to know
whether that is a problem, and what to do about it.

The policy is "artifacts first, publish last": **a failed or partial build never yields a
published release.** Anyone consuming `/releases` — a self-hoster's install script, a mirror,
your own deployment tooling — only ever sees complete ones.

## The sequence

| Step | Who | What |
|---|---|---|
| 1 | `release.yml` | Version PR merges → npm publish via changesets → protected `v<version>` tag pushed as the Release App |
| 2 | `release.yml` | GitHub Release created **as a draft** |
| 3 | `oss-snapshot-images.yml` | Fires on the **`master` push** of the release commit — builds, pushes and attests all 14 container images |
| 3 | `release-artifacts.yml` | Fires on the **tag push** — builds and attests the Cloudflare collab-worker tarball |
| 4 | `release-bom.yml` | Waits for both, re-verifies every attestation, collects every component's identity and digest |
| 5 | `release-bom.yml` | Assembles `release-manifest.json`, attests it, attaches manifest + attestation + the collab-worker tarball to the draft |
| 6 | `release-bom.yml` | Re-downloads the manifest **from the release**, verifies the attestation, asserts completeness |
| 7 | `release-bom.yml` | Re-resolves the tag, re-checks both producer runs, re-reads the attached manifest and the attached collab-worker tarball, and publishes with `gh release edit --draft=false --latest` — **all in one step**, **as the App** |

Step 3 is one row with two entries on purpose: the two producers are **not** both triggered by
the tag. `oss-snapshot-images.yml` builds off the `master` push of the release commit (so its
run carries `head_branch: master`); `release-artifacts.yml` builds off the tag push (so its run
carries `head_branch: <tag>`). The tag push and the `master` push race, which is why step 4's
wait budget is generous (up to two hours) — the snapshot matrix can still be mid-build when the
tag lands.

Step 7 exists because everything before it validated a **snapshot**. Between assembling the
manifest and publishing, the tag can be deleted or moved and a producer run can be re-run, and
neither is visible in anything already collected. It is deliberately **one step**, with the App
token minted just before it: splitting the re-check from the publish would reopen the very
window the re-check exists to close. Reads inside the step use `GITHUB_TOKEN`; the App token is
applied to the single write and nowhere else.

The last thing checked before publishing is the **attached assets themselves** — the manifest
and the collab-worker tarball. Every other check runs against the local copy downloaded earlier
in the job, and anyone with Release write access could `--clobber` that asset in the interval;
the checks would keep passing against the stale local copy while the Release published something
else entirely. So the currently attached bytes are re-read and required to be byte-identical to
what was verified. Byte equality, not a re-run of the semantic checks: a forged manifest can be
internally consistent, so "it still parses and looks complete" proves nothing.

A window remains and **cannot** be closed: between the last API response and the publish request
there is always some interval, and GitHub offers no compare-and-swap on releases — there is no
"publish only if the tag still points at X." That is the irreducible remainder, not an
oversight. Adding another check would only move which microsecond the gap sits in.

## What a stuck draft actually blocks

Read this before escalating. A draft release is less alarming than it looks.

**Not blocked — the artifacts already exist.** Both producer workflows already built, pushed
(or published) and attested their artifacts by the time this gate even starts collecting; a
stuck draft doesn't undo any of that. This gate only decides whether the *release object* on
`/releases` gets marked non-draft.

**Blocked:**

- **Visibility to anyone without push access.** GitHub only returns draft releases to callers
  with push access to the repository. An anonymous visitor, an unauthenticated
  `gh release download`, or a self-hoster's install script pointed at "the latest release" will
  not see a stuck draft at all — as far as they're concerned, it doesn't exist yet.
- **`--latest`.** GitHub ignores `make_latest` on a draft, so a stuck release can never become
  the one `/releases/latest` resolves to, even if you fetch its assets by tag directly.
- **The `release: published` webhook event.** Nothing that keys on that event — in this
  repository or downstream of it — fires until the gate passes. An action taken with
  `GITHUB_TOKEN` never triggers further workflow runs either, which is why this gate publishes
  with a GitHub App token instead: a `GITHUB_TOKEN` publish would look identical on `/releases`
  while silently never emitting that event.

The `resolve` and `publish` jobs need job-scoped `contents: write` on their own `GITHUB_TOKEN`s
purely to be able to *see* a draft at all — the same permission the point above depends on. The
Release App token is applied only to the final `gh release edit`.

## Re-running the assembler against a tag

Every step is idempotent: assets upload with `--clobber`, and publishing an already-published
release is a no-op.

```bash
gh workflow run release-bom.yml --ref v1.13.4 -f tag=v1.13.4
gh run watch "$(gh run list --workflow=release-bom.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

**Pass `--ref <tag>`, not just `-f tag=`.** GitHub itself does not need it: `resolve` turns the
tag into a commit SHA, the jobs that consume source (`collect`, `publish`) check that SHA out
explicitly, and no job binds a deployment environment. The downstream admission gate does need
it. The manifest's build-provenance attestation records the source ref the workflow ran from,
and a deployer that admits releases by that attestation requires `refs/tags/<tag>`. A dispatch
from `master` produces an attestation whose source ref is `refs/heads/master`: the release
publishes normally and is then refused at admission with
`expected SourceRepositoryRef to be refs/tags/<tag>, got refs/heads/master`. Because a published
release is immutable, that cannot be repaired afterwards — the only remedy is a new tag.
(Observed on `v1.14.4`, 2026-09-03.)

### Recovering a draft whose tag contains a broken BOM workflow

If `release-bom.yml` itself had a bug at the time a tag was pushed, do **not** dispatch the fixed
default-branch copy against the old tag: `--ref <tag>` would run the broken copy again, and a
dispatch from `master` would publish a release that fails admission (previous section). Merge
the fix to `master` and cut a new release. The old draft stays a draft and is never published;
the protected tag is never moved, deleted or recreated.

If a build workflow itself failed (not the BOM workflow), **re-run that run** instead — from the
Actions UI, or `gh run rerun <run-id>` / `gh run rerun <run-id> --failed`. The assembler reads
the newest **push** run for each producer, so it picks up a green re-run automatically.

**Dispatching a fresh run of a producer workflow does not help.** The assembler only ever
considers runs triggered by a `push` event; a `workflow_dispatch` run is ignored — never
selected, never recorded — because a dispatched run decides for itself what it checks out, and
nothing in its metadata reveals whether that matches the release commit. Re-running (which keeps
the run's id, its `head_sha` and its `push` event, and only increments `run_attempt`) is what
works.

## Reading a failure

The job summary names the failing component. The common ones:

| Message | Means | Do |
|---|---|---|
| `<workflow> for <tag> concluded 'failure'` | One of the two producers failed | Fix and re-run that workflow at the commit, then re-run the assembler |
| `Timed out after <n>m waiting for: …` | A producer never finished, or never started | The error lists every run seen at that SHA. If none carry the expected branch (`master` for the snapshot builder, the tag for the other), that producer's push run was never created |
| `PRODUCER NOT FROM A PUSH` | That workflow has no `push`-triggered run at this commit — only dispatched ones, which are ignored | See § No push run exists |
| `are declared at <tag> but are not on the npm registry at that version` | `npm publish` did not complete | Check the changesets step in `release.yml`; trusted publishing is configured **per package** on npmjs.com |
| `ARE on the npm registry but returned digest metadata this release cannot record as an identity` | The registry returned malformed integrity/shasum metadata | The publish itself succeeded — **do not re-publish**. Re-run the assembler; if the value repeats, raise it rather than weakening the check |
| `component '<x>' is expected in the release BOM but the manifest does not contain it` | The expected component set and the manifest disagree | If `<x>` is a newly added image or package, that's the gate working; if a component was deliberately removed, update `ACR_IMAGE_COMPONENTS` in `release-bom.yml` |
| `component '<x>' is in the manifest but is not an expected release component` | Same, in reverse | Usually a rename that landed in one list only |
| `has integrity '<x>' …` / `has shasum '<x>' …` | A component's identity field isn't well-formed | The publish likely succeeded — re-run the assembler rather than re-publishing |
| `No VISIBLE GitHub Release for <tag> appeared within <n>s` | The draft was never made, or the resolver lost the `contents: write` permission GitHub requires to list drafts | Verify the resolver permission first, then check `release.yml` for a failure between "Auto-tag" and "Create draft GitHub Release" |
| `TAG DELETED` / `TAG MOVED` | The tag changed while the BOM was building | Restore the tag at the recorded SHA, or investigate the protected-tag bypass that moved it. **Never publish past this** — see below |
| `PRODUCER SUPERSEDED` / `PRODUCER RE-RUN` / `PRODUCER NO LONGER GREEN` / `PRODUCER GONE` | A producing run was re-run or re-dispatched after the assembler cached its success | Wait for that run to settle, then re-run the assembler |
| `MANIFEST INCOMPLETE: …` | A required field the gate depends on (a producer's `runAttempt`, the collab-worker digest) is missing from the manifest | Re-run the assembler to regenerate it |
| `TAG LOOKUP FAILED` / `PRODUCER LOOKUP FAILED` | The GitHub API did not answer, so nothing could be confirmed — this is **not** evidence that anything is wrong with the release | Re-run once the API is healthy |
| `PRODUCER LOOKUP REFUSED` | The API is answering but the runs could not be listed | Check that the `publish` job still has `actions: read` |
| `MANIFEST SWAPPED` | The manifest asset attached to the release is no longer the file this run verified | **Do not publish by hand and do not just re-run.** Establish who replaced the asset first |
| `MANIFEST RE-READ FAILED` / `NO VERIFIED DIGEST` | The attached manifest could not be re-read, or no verified digest was recorded, so it could not be confirmed to be the verified one | Re-run the assembler |
| `PLATFORM ARTIFACT MISSING` | The collab-worker tarball isn't attached to the release, though the manifest promises it | Re-run the assembler to re-attach it |
| `PLATFORM ARTIFACT SWAPPED` | The attached collab-worker tarball no longer matches the digest the signed manifest records | **Do not publish by hand and do not just re-run.** Establish who replaced the asset first |
| `PUBLISH FAILED` | Every check passed but `gh release edit` did not succeed | The release stays a draft and the manifest is already attached, so re-running is safe once the cause is fixed |

A failure message never claims more than it knows. "The API did not answer" and "the tag is
gone" are the same exit code from `gh api` and completely different problems, so the gate probes
the API before blaming the tag — you should never be sent hunting for a deletion that never
happened. Every check runs before any of them aborts, so the log lists **all** current problems
rather than making you rediscover them one re-run at a time.

## No push run exists

`PRODUCER NOT FROM A PUSH` means something narrower than it may sound: not "a dispatched run got
in the way" — those are filtered out of selection entirely and cannot shadow anything — but "the
expected push never produced a run for this workflow at this commit, or that run no longer
exists."

For `release-artifacts.yml` (tag-triggered), recreating a deleted run means recreating the tag
push — a break-glass delete-and-re-push of the protected tag by the Release App. Weigh that
against simply cutting the next patch release, which is usually the cheaper answer. For
`oss-snapshot-images.yml` (`master`-triggered), there is no equivalent single command: its run
is tied to an actual push of that commit onto `master`, and a commit already merged into
`master`'s history cannot be "pushed" again to manufacture a new run for the same SHA.

Dispatching either workflow by hand will not clear this, by design — see § Re-running above. If
the artifacts genuinely exist and are genuinely from that commit, the honest path is to publish
by hand, below, and record why, rather than to loosen the gate.

## Publishing by hand, when the gate itself is wrong

Only when you have established that the artifacts are genuinely complete and the *gate* is
mistaken. Publishing by hand skips the completeness proof, so make sure both `release-manifest.json`
and the `collab-worker.tgz` tarball are attached to the release yourself if you want downstream
consumers to find them.

```bash
# Confirm what the gate saw
gh release view v1.13.4 --repo Fabric-Pro/fabric-oss --json assets,draft

# ALWAYS check the tag first — this is the one check never to skip.
# A draft carries a target_commitish (the default branch, since release.yml
# passes no --target). If the tag is missing, publishing RECREATES it there,
# shipping a release whose manifest describes a different commit.
git ls-remote --tags https://github.com/Fabric-Pro/fabric-oss.git 'refs/tags/v1.13.4^{}'   # must match the manifest's release.sourceSha

# Publish
gh release edit v1.13.4 --repo Fabric-Pro/fabric-oss --draft=false --latest
```

Never hand-publish past a `TAG DELETED` or `TAG MOVED` failure. Those two are the reason the tag
is re-resolved at step 7 at all, and the `protect-v-tags` ruleset does not protect you here: the
gate's own publish is performed by the Release App, which is that ruleset's bypass actor.

`gh release edit` run by a human publishes as that human, and a human-authored publish **does**
emit a normal `release: published` webhook event — only a `GITHUB_TOKEN`-authored one is
suppressed — so anything listening for that event downstream will still fire.

If the tag was pushed by hand and no Release exists, the assembler fails at the "wait for the
release to exist" step by design — create the draft first:

```bash
gh release create v1.13.4 --repo Fabric-Pro/fabric-oss --title v1.13.4 --notes-file notes.md --draft
```

Then file the gate's mistake, so the next release does not need a human.

## The manifest

`release-manifest.json`, attached to the release alongside `release-manifest.intoto.jsonl` (its
build-provenance attestation) and `collab-worker.tgz` (the one deployable artifact this
repository itself carries as a release asset rather than a record of one). Verify a downloaded
copy with:

```bash
gh release download v1.13.4 -p release-manifest.json
gh attestation verify release-manifest.json \
  --repo <owner>/<repo> \
  --signer-workflow <owner>/<repo>/.github/workflows/release-bom.yml
```

### Schema — `schemaVersion: "2.0.0"`

```jsonc
{
  "schemaVersion": "2.0.0",
  "kind": "fabric.release-manifest",
  "release": {
    "tag": "v1.13.4",
    "sourceSha": "<40-hex commit the tag resolves to>",
    "sourceRepository": "<owner>/<repo>",
    "generatedAt": "2026-08-20T12:34:56Z",
    "generatedBy": { "workflowRef": "…", "runId": "…", "runAttempt": "…", "runUrl": "…" }
  },
  "producers": [
    { "workflow": "oss-snapshot-images.yml", "runId": "…", "runAttempt": "…", "runUrl": "…", "conclusion": "success" },
    { "workflow": "release-artifacts.yml", "runId": "…", "runAttempt": "…", "runUrl": "…", "conclusion": "success" }
    // both must be "success". runAttempt is load-bearing: `gh run rerun` keeps
    // the run id and bumps the attempt, so the id alone cannot distinguish the
    // success recorded here from a later re-run that failed.
  ],
  "components": [ /* see the four shapes below */ ]
}
```

Every component carries `component`, `type` and `producedBy`. Four shapes:

**`oci-image`** — the migration runner and the 13 rolled-out container images, all built and
attested together by `oss-snapshot-images.yml`.

```jsonc
{
  "component": "migration-runner",
  "type": "oci-image",
  "registryRole": "ghcr-snapshot",
  "repository": "ghcr.io/<owner>/<repo>-snapshots/migration-runner",
  "tag": "<source-sha>",
  "digest": "sha256:<64 hex>",
  "reference": "<repository>@<digest>",
  "attestations": {
    "buildProvenance": "verified",     // every image gets both attestations
    "sbom": "verified",                // — the SBOM check is no longer special-cased
    "signerWorkflow": "<owner>/<repo>/.github/workflows/oss-snapshot-images.yml",
    "sourceDigest": "<release sourceSha>",
    "sourceRef": "refs/heads/master"
  },
  "producedBy": "oss-snapshot-images.yml"
}
```

Every image except `migration-runner` also carries `deployTarget` (`"fabric/<name>"`) — the
repository path a deployer imports it into. `migration-runner` is executed as a job rather than
rolled out as a service, so its row omits `deployTarget` entirely; the gate fails if it has one.

**`npm-package`** — one per non-private `@fabricorg/*` package at the release commit.

```jsonc
{
  "component": "@fabricorg/sdk",
  "type": "npm-package",
  "name": "@fabricorg/sdk",
  "version": "0.1.0",
  "registry": "https://registry.npmjs.org",
  "integrity": "sha512-…",
  "shasum": "…",
  "producedBy": "release.yml"
}
```

Read off the registry, not off a local pack. changesets skips versions already published, so
"already there" is the normal case — the manifest records **what shipped**, it does not
republish. Both fields are validated by *shape*, at collection and again at the gate: the shasum
must be 40 hex characters, and the integrity value must survive a length/padding regex **and
then actually decode** to the right number of bytes for its algorithm (sha512→64, sha384→48,
sha256→32, sha1→20). The decode is not belt-and-braces: the regex fixes the length and the
padding but cannot constrain the unused bits in the final base64 character, so a correctly sized
value ending `B==` satisfies it while being invalid base64.

**`platform-artifact`** — the collab-worker tarball. Built with no deploy credentials of any
kind, so it gets a real digest and a real provenance attestation, the same standard the 14
images meet.

```jsonc
{
  "component": "collab-worker",
  "type": "platform-artifact",
  "digest": "sha256:<64 hex>",
  "artifact": { "name": "collab-worker", "runId": "…", "runAttempt": "…" },
  "attestations": { "buildProvenance": "verified" },
  "producedBy": "release-artifacts.yml"
}
```

**`platform-source`** — the web app. Deliberately *not* held to the same standard.

```jsonc
{
  "component": "web",
  "type": "platform-source",
  "digest": null,
  "digestUnavailableReason": "…",
  "deployment": { "commit": "<release sourceSha>", "platform": "vercel" },
  "producedBy": null
}
```

`digest` is `null` **on purpose**. The web app inlines dozens of build-time public environment
values, so a bundle built without the real deployment environment is production-*incorrect*
rather than merely unverified — right code, wrong configuration — and that environment lives
with whoever deploys it, not with this repository. A fabricated digest would make the manifest
claim a guarantee it cannot back; the release records the source commit as `web`'s identity and
states plainly why there is nothing content-addressed to check.

This manifest records what this repository built and attested. It does not record what actually
got rolled out to a live environment — which images got pulled, which commit `web` was deployed
from — that happens downstream, using a published release as its input, and isn't tracked here.

## Changing the expected component set

The gate compares the manifest against a set re-derived at publish time, so adding a component
in one place and not the other fails the release rather than shipping a silent hole.

- **A new container image** — add it to `ACR_IMAGE_COMPONENTS` in `release-bom.yml`, and keep it
  in sync with wherever your deployment tooling enumerates images to pull.
- **A new publishable npm package** — nothing to do. The set is enumerated from the tree at the
  release commit (non-private `@fabricorg/*`), so a new package is expected automatically. The
  first release after adding one fails if its npmjs.com trusted publisher is not configured yet,
  which is the point.
- **A new platform component** — add it to the "Collect the platform component rows" step and to
  the expected set in the publish gate.

## Related

- `.github/workflows/release.yml` — creates the draft
- `.github/workflows/release-bom.yml` — this gate
- `.github/workflows/oss-snapshot-images.yml` — builds and attests the 14 container images
- `.github/workflows/release-artifacts.yml` — builds and attests the collab-worker tarball
