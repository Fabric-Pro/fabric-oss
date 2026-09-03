---
"@repo/temporal": patch
---

Stop sending the internal staging hostname in the PM-sync worker's User-Agent

`fetchImageWithFallback`'s User-Agent header carried the URL of one internal
staging deployment, which means nothing to a self-hosted deployment or to any
third party inspecting inbound request headers. Every outbound fetch this worker
makes now identifies itself as `Fabric-Sync/1.0 (+https://fabric.pro; pm-sync worker)`,
the public product site, which resolves regardless of who is running the worker.
