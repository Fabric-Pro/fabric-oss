---
"fabric-app": patch
"@fabricorg/cli": patch
"@fabricorg/sdk": patch
---

Publishing a project's coding instructions now pre-builds the download archive, and the builder fetches the snapshot's files concurrently instead of one at a time, so the first `fabric instructions sync` or `init` of a newly published version no longer times out on a large instruction tree.

The command line also gives the download-link request its own longer budget and stops retrying it, because a retry that fired on a timeout started a second build of the same archive on the server rather than waiting for the first.

The SDK's `createDownloadUrl` request is no longer retried either, for the same reason: a retry does not wait for a build already in flight, it starts another.
