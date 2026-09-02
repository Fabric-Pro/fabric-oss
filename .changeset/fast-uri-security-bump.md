---
"fabric-app": patch
---

Raise the fast-uri pnpm override floor to clear four high-severity advisories

The root `package.json` pinned a pnpm override of `fast-uri@^3.0.0` to `^3.1.5`, and the lockfile had resolved that range to the vulnerable `3.1.5` release. All four advisories are fixed starting in `3.1.6` on the 3.x line:

- GHSA-5jgf-p345-68v8
- GHSA-f65p-4m7j-42xc
- GHSA-fph4-wmhf-6fwf
- GHSA-jqff-g426-hqxp

Bumping the override floor to `^3.1.6` and refreshing the lockfile resolves every `fast-uri` entry to `3.1.7`. `fast-uri` is a transitive dependency of the ajv/fastify JSON-Schema validation chain, so no application code changed — only the resolved dependency version.

This unblocks the `Dependency audit (high+)` / `security` aggregate CI check for every PR based on current master, which was otherwise failing with 4 undismissed high-severity findings.
