---
"fabric-app": patch
---

Test runs show per-step evidence for scripted cases, a cost estimate before an Agentic run, and a clearer reason when a navigation is blocked.

Four related QA follow-ups from a review of the test-run feature (Fizzy #2232–#2235):

- Scripted-run assertion failures (`assertUrl`, `assertText`) now carry `Expected:`/`Received:` pairs in the Jest-style shape `parseAssertionValues` already recognises, so the RCA model and bug bodies get real values instead of a bare "did not match" sentence. `assertVisible` now names its locator.
- A scripted case reports one `AgenticStepResult` per plan action (PASSED/FAILED/SKIPPED, labelled from the saved script) instead of collapsing the whole plan into a single synthetic row, with the runner's per-step outcomes validated defensively and falling back to the old single-row shape when malformed or absent. A setup/sign-in failure still records one BLOCKED row, since it never reached the plan.
- The run-configuration dialog adds a read-only `agenticRuns.quote` procedure — sharing its resolution helpers with `dispatch` so the two cannot disagree — and shows the resolved case count, step count and estimated cost for Agentic before Start, requires a second "Confirm and start" step naming the figure, dispatches Scripted directly (it costs nothing), and defaults the runner to the viewer's last dispatched choice (remembered per project in `localStorage`) or to Scripted when every selected case already has a saved script — but only when the viewer may run scripted tests: the quote reports `scripted.permitted` from the same owner/`PROJECT_SETTINGS_EDIT` gate dispatch enforces, and the Scripted option is disabled with a reason otherwise. The dispatch success toast now names what started; `AgenticRunsPanel` and `QaPanel` now invalidate the router-level `agenticRuns` query key so a just-dispatched run appears without a reload. Server-side double-submit dedupe remains out of scope.
- `net::ERR_BLOCKED_BY_CLIENT` on a navigation failure now carries a plain-language explanation naming which side refused: an off-origin redirect or a same-origin address that resolved unsafely both point at the environment's configuration, while a proxied fetch failure points at Fabric's own network. The scripted runner records the same off-origin explanation for parity. A refused URL is kept, logged and shown as origin + path only, since an OAuth/SSO redirect's query or fragment can carry a code or token.

Docs updated: `apps/web/content/docs/features/testing/cases.mdx` and `docs/qa/agentic-runs.md` now describe per-step scripted evidence (no screenshots) instead of promising Mode A's evidence shape unconditionally, and the pre-dispatch quote.
