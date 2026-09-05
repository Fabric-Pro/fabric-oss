---
"fabric-app": patch
---

Raise pnpm override floors for the dompurify, postcss-selector-parser and uuid transitive dependency advisories.

Follow-up to the five-advisory sweep: Dependabot's security jobs cannot bump transitive-only
pnpm dependencies, so the fixed versions land through root `pnpm.overrides` instead.
`dompurify@^3.0.0` moves from `^3.4.12` to `^3.4.13` (resolves 3.4.13, deduplicating the
copy mermaid already used), a new `postcss-selector-parser@^7.0.0 -> ^7.1.3` floor resolves
7.1.6, and a new cross-major `uuid@>=8.0.0 <11.0.0 -> ^11.1.1` floor retires uuid 8.3.2,
9.0.1 and 10.0.0 from the lockfile. Every consumer of those uuid majors imports the bare
package and only uses v4, v5, v6, v7 and validate, all of which uuid 11 still exports, and no
package declares uuid as a peer, so the range override rewrites nothing else. The two esbuild
advisories are not fixable by override (drizzle-kit and partykit have no release off the
vulnerable lines; wrangler's fixed line needs a workers-types major bump) and the
@ai-sdk/provider-utils advisory has no fixed version yet. Lockfile hand-edited per the
transitive-bump recipe and proven with `pnpm install --frozen-lockfile --lockfile-only`.
