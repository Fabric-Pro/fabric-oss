---
"fabric-app": patch
---

Reject commit subjects over 120 characters at authorship, so the published-side length limit no longer costs a round trip.

A commit subject longer than 120 characters is refused when the change is published,
and the refusal only arrives after every required check has already passed — so it
costs a full cycle: amend, force-push, re-authorize. One change was refused at 121
characters, a single character over, with every check green.

`.githooks/commit-msg` already made exactly this argument for the DCO trailer
("catching it at authorship costs nothing and removes the round trip") but checked
only that trailer and the identifier scan. The length check goes between them, before
the node call, so the identifier scan still runs last and still determines the hook's
exit status.

Which line git will treat as the subject is not knowable from a commit-msg hook.
Cleanup mode decides whether comment lines and trailing whitespace survive, and it
cannot be observed here: `commit.cleanup=default` means `strip` when the message was
edited but `whitespace` when it was not, `scissors` keeps comments, and
`git commit --cleanup=<mode>` overrides the config a hook could read. So the check
measures all three plausible readings — raw, `git stripspace`, and
`git stripspace --strip-comments` — and rejects only when every one of them exceeds the
limit. That cannot reject a message git would have accepted, and still catches the
ordinary case, where all three readings are the same line.

Length is a byte count over ASCII, which is exact and locale-independent. A non-ASCII
subject stands down instead: `wc -m` counts bytes under `LC_ALL=C`, POSIX guarantees no
UTF-8 locale to switch to, and an over-count would reject a valid commit. No subject in
this repository's history is non-ASCII, so that concession costs nothing.

The bias throughout is deliberate. A false rejection cannot be worked around without
`--no-verify`; a miss is still caught downstream, at the cost of one round trip.
