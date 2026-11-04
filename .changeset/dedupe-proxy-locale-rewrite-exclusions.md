---
"fabric-app": patch
---

Keep `/docs-sitemap.xml` excluded from `beforeFiles` locale rewrites and lock the excluded-path list shared between `proxy.ts` and `lib/locale-rewrite.ts` against drift.
