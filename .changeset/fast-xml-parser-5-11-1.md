---
"fabric-app": patch
---

Raise the fast-xml-parser v5 floor to 5.11.1 so JUnit result parsing picks up upstream's DOCTYPE hardening and malformed-tag fix.

Replaces Dependabot #103, which reached the same 5.11.1 resolution but through a
full lockfile regeneration: 938 changed lines dragging in AWS SDK, axios
1.19.0 -> 1.20.0, langchain, langsmith 0.8.10 -> 0.10.1 and rollup, none of it
related to fast-xml-parser. This lands the same bump in 60 lines confined to
fast-xml-parser and its own dependency subtree (strnum, @nodable/entities,
path-expression-matcher, plus new deps anynum / is-unsafe / xml-naming).

Done by raising the `fast-xml-parser@^5.0.0` override floor from ^5.7.0 to
^5.11.1 and hand-applying only the resulting subtree hunks. A plain
`pnpm install --lockfile-only` could not be used: pnpm's peer resolution is
non-deterministic on this workspace (zod peer keys under @better-auth/core and
@langchain/core flip between runs), so any full re-resolution buries the real
change in churn. The committed lockfile passes
`pnpm install --frozen-lockfile --lockfile-only` unchanged.

Only consumer is packages/temporal's junit-xml fetcher, which parses with
parseAttributeValue/parseTagValue off, so the strnum number-parsing changes in
5.8/5.9 cannot reach it. 69 pipeline-results fetcher tests pass; knip exits 0.

Note this does NOT close GHSA-gh4j-gqv2-49f6. That advisory is open against the
separate fast-xml-parser 4.5.6 resolution pulled by @langchain/community 0.3.57,
which has no v4 fix available and needs its own change.
