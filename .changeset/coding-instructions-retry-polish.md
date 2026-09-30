---
"fabric-app": patch
---

The coding instructions upload names an oversized file before uploading, sizes read as "5 MB", and a retried check no longer looks failed.

The upload dialog now blocks on a kept file over the per-file limit and names the largest one with its size and the limit, and the server's file-too-large message uses the same wording through a shared byte formatter in `@repo/instructions`. While Retry checks is in flight the button reads "Retrying checks…", is marked busy, and Upload again is disabled. After a retry publishes a synced version, the latest sync line says its checks were retried and it is now published instead of repeating that they stopped.

The sync-run limit-detail parser moved to its own zod-only module (`instruction-sync-limit-detail.ts`, still exported from `@repo/database`), so the repository-sync procedures test loads it without the Prisma client: that suite went from ~12 s to ~1 s and no longer hits its 20 s beforeAll timeout on a busy run. The web-only `format-bytes.ts` re-export is gone; callers use `formatByteSize` from `@repo/instructions`.
