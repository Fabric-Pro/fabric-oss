---
"fabric-app": patch
---

Patch GHSA-ggr8-5vv4-36mx by overriding `deepmerge-ts` to 8.0.2 and retire its documented dismissal

`@prisma/config` (via `prisma@6.18.0`) pins `deepmerge-ts` at exactly `7.1.5`, and the fix for the
stack-exhaustion advisory landed in the `8.0.0` major, so the advisory was previously a documented
dismissal in `osv-scanner.toml` / `SECURITY.md` with a note to take the override on renewal. This
takes it now: a root `pnpm.overrides` entry `deepmerge-ts` -> `^8.0.2` replaces the exact pin, the
lockfile was hand-edited to the four `deepmerge-ts` hunks and proven with
`pnpm install --frozen-lockfile --lockfile-only`, the `osv-scanner.toml` entry is removed, and the
`SECURITY.md` row moves to the removed-dismissals table with the verification notes.

The sibling `extract-zip` dismissal (GHSA-jmr9-qjv8-65gv) stays: re-checked 2026-09-02, `2.0.1` is
still the newest release and `@langchain/langgraph-cli@1.4.5` still declares it. Its comment and
SECURITY.md row are refreshed with that date and version.
