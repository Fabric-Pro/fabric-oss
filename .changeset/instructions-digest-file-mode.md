---
"fabric-app": patch
"@fabricorg/cli": patch
---

A coding-instructions version that only changes a file's executable bit now gets a new digest, so `sinceDigest` callers and `fabric instructions sync` pick it up instead of reporting no change. The CLI still installs versions published before this change; an older CLI release refuses a newly published version that contains an executable file until it is upgraded.
