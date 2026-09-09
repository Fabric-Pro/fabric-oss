---
"fabric-app": patch
---

Patch seven dependency advisories, including two unauthenticated remote-code-execution criticals in Next.js

`next` 16.2.11 → 16.3.3 clears GHSA-2xp9-vwfh-vxw4 (unauthenticated RCE in the Image Optimization API via AVIF) and GHSA-p293-qw3h-jr36 (unauthenticated RCE on Windows-hosted servers, CVSS 9.0). `sharp` → 0.35.4, `@tiptap/core` → 3.31.3 and `js-yaml` → 3.15.2 / 4.3.2 clear four highs. `extract-zip` GHSA-7pqw-9j4j-h8q3 has no upstream fix and is dismissed alongside its existing sibling entry, with the same expiry and the same reachability argument.

These published after the last master security run, so they were failing every open PR rather than anything specific to this branch.

Two of the fixes needed more than a version bump:

`better-auth` takes `next` as an optional peer, so bumping Next re-keys its whole peer suffix and pnpm re-resolved the island from scratch — producing a SECOND `@better-auth/core` at `@better-fetch/fetch@1.1.21` / `better-call@1.3.5` beside the good one. `apps/web` then type-checked against the old better-fetch and produced 51 errors across every auth, organization and settings component. Proven by bisection: the Next bump alone reproduces it, and the committed lockfile is otherwise reproducible with zero edits. Fixed by pinning the three peers to the versions already in use, so a Next bump cannot silently fork the island.

`next` also carries its own `sharp` optional peer and resolved it to 0.35.3, which the existing `sharp@<0.35.0` override could not reach — so the libheif advisory survived bumping every first-party declaration. A `sharp@^0.35.0` key catches the 0.35.x line itself.
