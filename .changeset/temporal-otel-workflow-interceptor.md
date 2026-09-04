---
"fabric-app": patch
---

Bundle the OpenTelemetry workflow interceptor so Temporal workflow spans are actually produced and exported

The Temporal worker registered the `exporter` sink that workflow-side
OpenTelemetry spans leave the sandbox through, and allocated the batch span
processor behind it, but never registered the interceptor module that creates
those spans. The SDK's workflow-side `SpanExporter` is the sink's only caller
and is only constructed by that module, so no workflow span had ever been
produced: traces showed activity spans with no workflow parent, and the span
processor sat idle from boot. The activity-side interceptor was unaffected.

`getTelemetryInterceptors()` now returns the module under
`interceptors.workflowModules`, which `buildWorkflowBundleOptions()` already
merges into `bundleWorkflowCode({ workflowInterceptorModules })` — the one
registration point the SDK honours for a worker created from a prebuilt bundle
(Fizzy #2400). Because the telemetry layer contributes it, the module is only
bundled when telemetry is initialised; the worker strips the key from its own
options as before, so nothing is registered where the SDK would discard it.

Replay safety, checked rather than assumed: the SDK's span and trace IDs come
from a named workflow random stream that does not consume the workflow's
`Math.random()` sequence, so existing histories see the same random values as
before; `performance.now()` is polyfilled from workflow time; and spans leave
the isolate through a sink the worker never invokes while replaying. Replay
validation was run with the interceptor live against histories fetched from a
local development Temporal server and passed. The replay gate now registers the
OpenTelemetry module explicitly alongside the correlation interceptor — the
bundle options only carry it once `initTelemetry()` has run, which never
happens in a test, while every production worker has it — and registers the
`exporter` sink shape so the replay worker does not log an unregistered-sink
error per span.

The new `telemetry-workflow-interceptor` test loads the telemetry module under
stubbed env, runs the real `initTelemetry()` against a port nothing listens on,
and asserts the module is contributed only when telemetry is on, that the
bundle options `worker.ts` uses carry it next to the correlation interceptor,
and — by bundling for real — that it lands in the sandbox with the SDK's
workflow-imports alias applied.

Fizzy #2401.
