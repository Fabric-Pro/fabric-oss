---
"fabric-app": patch
---

Override the transitive `toml` parser to 4.3.0 so a crafted TOML front matter block can no longer pollute `Object.prototype` (GHSA-v5mp-jgw5-2x6j).

`remark-mdx-frontmatter@4.0.0` (via `mdx-bundler`) declares `toml@^3.0.0`, and 3.0.0 is the last release on that major. GHSA-v5mp-jgw5-2x6j (prototype pollution through a `__proto__` key path, high) was published against `< 4.1.2` on 2026-09-03 and failed the `Dependency audit (high+)` job on the fabric-oss release PR. The `pnpm.overrides` floor of `^4.3.0` also clears GHSA-82x6-q7mm-w9cf (unbounded nesting stack overflow, fixed in 4.2.0) and stops short of 5.0.0, which changes integer-range handling. The only call site is `parse()` on MDX front matter at build time; verified the named CJS export still resolves under ESM import. Lockfile hand-edited and proven with `pnpm install --frozen-lockfile --lockfile-only`.
