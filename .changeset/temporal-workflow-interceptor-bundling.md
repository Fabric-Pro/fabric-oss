---
"fabric-app": patch
---

Register the correlation workflow interceptor with the workflow bundler so workflow → activity correlation-ID propagation actually runs

The Temporal worker registered its workflow-side correlation interceptor via
`WorkerOptions.interceptors.workflowModules`. The SDK discards that key on any
worker created from a prebuilt `workflowBundle` — it logs a warning at boot and
carries on — and every worker here is created from one prebuilt bundle. The
workflow half of the correlation chain had therefore never run, despite the code
and its comments describing the behaviour as active. The activity-inbound half
was unaffected and did work.

The modules now go to `bundleWorkflowCode({ workflowInterceptorModules })`, which
is the only registration point the SDK honours in this configuration, and the
worker no longer sets the key the SDK would throw away. Whatever the telemetry
layer contributes is merged at the same call site rather than silently dropped.

The bundle options move into `lib/workflow-bundle-options.ts`. `worker.ts`
self-executes on import, so nothing can load it to check how it bundles;
extracting the options gives the tests the same object production passes to the
bundler instead of a copy that can drift from it.

Verification: replay validation was run with the interceptor live against
histories freshly fetched from a local development Temporal server — 30 workflow
types, closed and running, all replay clean. That exercises the interceptor
against real recorded histories, though not against production's data shapes.
The replay gate now registers the same interceptor stack the worker runs, which
it previously did not, so it can actually catch a determinism problem the
interceptor introduces; CI runs it on changes under src/workflows.

The new `workflow-interceptor-bundling` test bundles for real (~1.5s) and
asserts the interceptor is in the output, asserts the options carry every
declared module, and asserts `worker.ts` still builds from those options. Each
assertion was confirmed to fail when the corresponding bug is reintroduced —
including the case where the module list is emptied while the identifier stays
referenced, which a plain source-text check would have missed.

Fizzy #2400.
