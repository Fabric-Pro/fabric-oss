---
"fabric-app": patch
---

Fix a flaky reasoning-trace unit test by sampling the completion time once per reasoning update

`buildReasoningUpdate` in `packages/agent-core/src/reasoning-trace/emit.ts` called `Date.now()` twice, once for `durationMs` and once for `completedAt`. The test that pins `durationMs === completedAt - startedAt` failed whenever the clock ticked a millisecond between the two calls, so any PR could lose the required `unit-tests` check on a change unrelated to this package.

The two samples were kept on purpose to stay byte-identical with the pre-refactor in-tree implementation. Sampling once changes the recorded duration by at most the elapsed time between the two samples and keeps the in-memory entry internally consistent, so the caveat comment goes with it. No test changes: the assertion was right, the source was not.
