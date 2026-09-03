---
"fabric-app": patch
---

Stop the context-export repeat-archive test from failing when its two exports straddle a second boundary.

The test asserts that exporting the same rows twice yields a byte-identical archive, but the manifest carries an "Exported at" second, so a run that crossed a second boundary between the two calls failed on that line alone (fabric-dev run 33735140558 on PR #160, a PR that never touched this code). The test now freezes Date for its duration and restores real timers afterwards; only Date is faked so the archive streams keep their real timers.
