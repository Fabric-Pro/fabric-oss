---
"fabric-app": patch
---

Raise the undici and ip-address dependency floors to their patched releases, closing a WebSocket decompression denial-of-service advisory in undici and IPv6 link-local and NAT64 misclassification advisories in ip-address.

undici moves 8.10.0 -> 8.11.2 (the direct dependency behind the LLM gateway
fetch wrappers and the SSRF-pinned fetch in `@repo/utils`), and its transitive
6.x and 7.x copies move to the patch releases 6.28.1 and 7.29.1. ip-address,
used only by express-rate-limit, moves 10.3.1 -> 10.7.2. All four are
same-major bug-fix or additive releases.

Replaces Dependabot #724 and #723. #724 regenerated the lockfile and churned
unrelated langchain peer keys; it also left the 6.x and 7.x copies on
vulnerable versions. This change raises the override floors in
`pnpm-workspace.yaml` and edits only the lockfile entries for these four
versions, plus the peer-suffix keys that embed `undici@8.x` through openai's
optional peer. It passes `pnpm install --frozen-lockfile --lockfile-only`
unchanged and a real frozen install.
