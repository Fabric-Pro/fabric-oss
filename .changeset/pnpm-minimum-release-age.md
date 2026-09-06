---
"fabric-app": patch
---

Quarantine freshly published dependency versions for 24 hours before pnpm will resolve or install them

Enables pnpm's `minimumReleaseAge` at 1440 minutes, the guard added after the 2025
npm supply-chain compromises. A hijacked release is usually caught and pulled
within hours, so waiting a day keeps most of that window out of the lockfile —
exposure reduction rather than a guarantee. 1440 is pnpm 11's
own default; the pnpm 11 migration deliberately pinned it to 0 so that config move
would not change what resolves, and left the policy decision for this change
(Fizzy #2419).

Three settings, in `pnpm-workspace.yaml`:

- `minimumReleaseAge: 1440` — the quarantine window.
- `minimumReleaseAgeStrict: true` — fail rather than self-exempt. In loose mode
  pnpm answers an immature pick by writing it into `minimumReleaseAgeExclude` and
  carrying on, which opens a hole in the policy with nobody deciding to. Strict
  prompts in a terminal and aborts in CI, naming every offending version. pnpm
  already infers this whenever `minimumReleaseAge` is set explicitly; it is
  written out so the behaviour cannot silently invert if that coupling changes.
- `minimumReleaseAgeExcludePrune: true` — an exemption is dropped once the version
  it names leaves the lockfile, so the exclude list cannot silt up into a set of
  standing holes nobody remembers granting.

The card scoping this expected CI to be unaffected, on the theory that a frozen
install resolves nothing. That is true of pnpm 10 and wrong for pnpm 11: since
11.1.3 `pnpm install` re-verifies existing lockfile entries against the active
policy before fetching any tarball, so a workspace install with
`--frozen-lockfile` — the CI jobs and the ten agent Dockerfiles, which copy
`pnpm-workspace.yaml` — fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` when
the lockfile carries a version younger than the cutoff. That is the property
worth having: it is what stops a lockfile resolved on a laptop with the policy
off from installing anyway in CI. The consequence to plan around is that a
dependency bump now cannot land until the version it pins is a day old —
including a Dependabot PR, which cannot wait or exempt itself and simply stays
red until its pick matures.

Verified against the repo's own lockfile before merging: all 3283 entries pass
(`✓ Lockfile passes supply-chain policies`), so nothing in tree needs an
exemption and no seed entries were added. The check took ~12s per install in the
CI shape measured here — warm store, cold cache, since `actions/setup-node`
caches the pnpm store and not `~/.cache/pnpm`. A repeat install against an
unchanged lockfile hits a cached verdict and was near-instant (~0.4s).

`.github/dependabot.yml` and `CONTRIBUTING.md` both record the Dependabot
interaction, since a red bot PR with this error is otherwise a puzzle.
`CONTRIBUTING.md` gains a "Dependency updates" section naming both errors
(`ERR_PNPM_NO_MATURE_MATCHING_VERSION` on resolve,
`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` on install) and the escape hatch: pin the
exact version in `minimumReleaseAgeExclude`, land it in the same PR as the
lockfile, and justify it there, so an exemption is reviewed like any other change.
