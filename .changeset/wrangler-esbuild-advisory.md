---
"fabric-app": patch
---

Bump wrangler in both Cloudflare workers to 4.107.1 so its bundled esbuild moves off the 0.27.x advisory range

Context (Fizzy #2418): the fabric-oss Dependabot alert for GHSA-g7r4-m6w7-qqqr (esbuild >= 0.27.3 < 0.28.1, arbitrary file read by esbuild's dev server on Windows) reached the lockfile only through wrangler@4.85.0, which pins esbuild 0.27.3 exactly. A pnpm.overrides floor cannot close it because esbuild 0.x minors are breaking and wrangler pins the exact version, so the fix is the wrangler bump itself.

Why 4.107.1 and not the latest 4.x: wrangler 4.102.0 is the first release on esbuild 0.28.1, and 4.108.0 is the first whose peer moved to @cloudflare/workers-types 5. party-cf's runtime dependencies partyserver 0.5.2 and y-partyserver 2.2.0 (the latest y-partyserver) still declare a workers-types ^4 peer, so workers-types 5 would leave unmet peers on the collab worker; 4.107.1 is the last wrangler on the v4 peer line and still ships stable miniflare 4 (4.118.0 onwards depends on a miniflare 5 alpha). The range is a tilde pin on purpose: a caret re-resolves straight to 4.129.0, which was observed to reintroduce the v5 peer warning. @cloudflare/workers-types is raised to ^4.20260702.1 in both workspaces to satisfy the new wrangler peer.

Lockfile: only the wrangler subtree was regenerated (wrangler, miniflare, workerd and its platform binaries, esbuild and its platform binaries, @cloudflare/kv-asset-handler 0.4.2 -> 0.5.0, @cloudflare/unenv-preset peer key, @cloudflare/workers-types), plus the workers-types peer-suffix rename on the better-auth and drizzle-orm snapshot keys that carry it. The full pnpm re-resolve also flipped unrelated zod peer keys under @better-auth/core; those hunks were left out. Proven with pnpm install --frozen-lockfile --lockfile-only (unchanged), tsc --noEmit in party-cf and services/sandbox-worker, and wrangler deploy --dry-run bundles for both workers.

Not touched: the other esbuild alert (<= 0.24.2) comes from drizzle-kit and partykit, neither of which has an upstream release off it.
