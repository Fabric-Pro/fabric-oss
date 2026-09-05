---
"fabric-app": patch
---

Resolve open dependency advisories for qs, @xmldom/xmldom, @humanfs/node, fflate and @simplewebauthn/server via root pnpm overrides.

All five are transitive-only dependencies (pulled in by express/body-parser/stripe,
mammoth, eslint, jspdf and @better-auth/passkey). Dependabot's security-update jobs
for them fail with `security_update_not_possible` because it drives pnpm with
`pnpm update <name>@<version> --lockfile-only --no-save -r`, and that form only
rewrites direct dependencies — on a transitive-only package it is a no-op, so the
lockfile keeps the old version and Dependabot concludes no fix is installable.
Reproduced against master with the pinned pnpm 10.14.0; the bare `pnpm update <name>`
form does bump them, so the parent ranges permit the fix.

The repo's mechanism for this class is root `pnpm.overrides`. Two existing floors
were behind the fixed versions (qs `^6.15.2` -> `^6.16.0`, @xmldom/xmldom `^0.8.13`
-> `^0.8.15`); fflate `^0.8.3`, @humanfs/node `^0.16.8` and @simplewebauthn/server
`^13.3.2` are new. Resolved versions: qs 6.16.0, @xmldom/xmldom 0.8.15,
@humanfs/node 0.16.8 (+ @humanfs/core 0.19.2, @humanfs/types 0.15.0), fflate 0.8.3,
@simplewebauthn/server 13.3.3.

Lockfile edited per the hand-edit recipe: full `pnpm install --lockfile-only` in a
scratch copy, then only the hunks naming these packages or their subtrees applied
(dropped: eslint-plugin-import peer-key churn and an unrelated internal-slot
side-channel bump). `pnpm install --frozen-lockfile --lockfile-only` passes and
leaves the file unchanged.
