---
"fabric-app": patch
"@fabricorg/cli": patch
"@fabricorg/sdk": patch
---

A coding-instruction proposal that is sent twice — a client retrying after a timeout, or the same push repeated — now returns the pending proposal that already exists instead of opening a duplicate that holds a second review slot, and the browser tab refuses an identical pending proposal with a message naming the version to review or cancel. Because a repeated push is now safe, the CLI and the SDK retry a transient network failure on `instructions push` again rather than failing on the first one.

A proposal is identified by its content: the published version it is stated against, together with the set of paths, operations and file hashes it applies. When a repeated push is answered with a proposal that is not simply waiting for review, the command line and the coding-agent tool now say which state it is in and what to do about it — that an earlier attempt is still sending the same change, which can be cancelled from the Coding Instructions tab or left to be closed out automatically after six hours; that its checks did not pass and it should be retried from that tab; that it was closed out and should be pushed again; or that it has already been approved — instead of reporting in every case that it is waiting for review.
