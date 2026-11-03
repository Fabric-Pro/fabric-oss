---
"fabric-app": patch
---

Fix an infinite 307 redirect loop on `/` and unprefixed marketing pages when the web server is bound to a loopback IP such as `127.0.0.1` or `::1`.

Hand same-origin `next-intl` locale rewrites off from `proxy.ts` to `next.config.ts` `beforeFiles` path rewrites so Next.js 16 does not treat `NextURL`'s `localhost` normalization as an external HTTP proxy request back into `/en`.
