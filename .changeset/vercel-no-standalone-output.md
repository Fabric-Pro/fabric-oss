---
"fabric-app": patch
---

Stop asking for standalone output on Vercel, which failed every deploy on Next 16.3 with a missing next-server.js.nft.json

Every Vercel build since the Next 16.2.11 → 16.3.3 bump compiled cleanly and then died right after "Running onBuildComplete from Vercel":

    Error: ENOENT: no such file or directory, open '/vercel/path0/apps/web/.next/next-server.js.nft.json'

Root cause, confirmed against the published Next 16.3.3 and 16.3.4 packages and upstream issue vercel/next.js#96646: since 16.3.0 (PR #93684) Turbopack skips emitting the whole-app `next-server.js.nft.json` whenever a build adapter is configured, on the premise that adapters never read it. Vercel now injects its adapter through NEXT_ADAPTER_PATH on every build. But `output: "standalone"` has a second reader of that file — the standalone finaliser (`copyTracedFiles`) — which reads it unguarded, and our Vercel build command exports DOCKER_BUILD=true, which is what turned standalone on. 16.3.4 is byte-identical to 16.3.3 in the whole build pipeline, so the pending Next bump does not change this; the upstream fix only reached the 16.3 branch on 2026-09-04.

Standalone output has no consumer on Vercel — the platform packages each route from its per-entry trace and ignores `.next/standalone` — so the copy only ever cost build time and memory there (the failing builds peaked at 15.3 GB of the 16 GB machine). `output` is now keyed on DOCKER_BUILD *and* not-Vercel; the Docker image build is unchanged. Verified by a preview deployment of this change.
