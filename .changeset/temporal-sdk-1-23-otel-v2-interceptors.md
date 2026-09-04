---
"fabric-app": patch
---

Upgrade the Temporal TypeScript SDK to 1.23 and move worker tracing to the OpenTelemetry v2 interceptors

`@temporalio/*` was pinned at `~1.16.3` and the worker traced through `@temporalio/interceptors-opentelemetry`, the last package in the repo still built against OpenTelemetry v1. Everything else — the `NodeSDK`, the exporters, `@opentelemetry/resources`, `@opentelemetry/sdk-metrics` — moved to v2 some time ago, so that one package held a whole second OpenTelemetry island in the lockfile purely to serve itself.

Upstream closed `temporalio/sdk-typescript` issue 1658 by publishing `@temporalio/interceptors-opentelemetry-v2` alongside SDK 1.19.0. It peer-depends on the exact SDK version, so it cannot ship without the version bump; the two are one change.

What moved:

- `@temporalio/activity`, `client`, `common`, `worker`, `workflow` and `testing` in `packages/temporal`, plus `@temporalio/client` in `packages/api` and `packages/rag`, go to `~1.23.0`. The tilde stays deliberate — see the 1.16.3 bump, which fixed a `reuseV8Context` module-cache leak; `^` would let the worker drift across minors on any install.
- `packages/temporal/src/telemetry.ts` imports the `-v2` package. Its `makeWorkflowExporter` takes a `SpanProcessor` rather than a raw exporter, so workflow spans now go through a `BatchSpanProcessor` and the two `as any` casts that papered over the v1/v2 type mismatch are gone.
- `apps/web/next.config.ts` names the new package in `serverExternalPackages`.

Two things the migration forced that are worth knowing:

**The workflow span processor owns its own exporter and its own shutdown.** v1's exporter overload called `exporter.export(spans, noop)` inline; a `SpanProcessor` receives `onEnd` and buffers, so buffered spans are lost unless something flushes them. `shutdownTelemetry()` now drains it. Two details that only show up when you run it: it deliberately does *not* share `traceExporter` with the `NodeSDK`, because `BatchSpanProcessor.shutdown()` and `NodeSDK.shutdown()` both shut the exporter down and whichever ran second would fail its final flush silently; and the drain is wrapped in a `try`, because a bare `BatchSpanProcessor` *rejects* when its last export fails where `NodeSDK.shutdown()` and `LoggerProvider.shutdown()` swallow it. `worker.ts` calls `process.exit(0)` straight after `shutdownTelemetry()`, so an unreachable collector would otherwise hang the worker on SIGTERM until something killed it. Verified both ways against a closed port. The queue is also sized explicitly at 8192 rather than left at the SDK's 2048 default: batching is what we want here, since the v1 path fired one unbounded gRPC export per sink call and every export is billed ingestion downstream, but a `BatchSpanProcessor` queue is bounded and drops on overflow where the v1 path could not. At the default, 3000 spans submitted against a collector that is merely keeping up already lose 440 of them; at 8192 they all land. Dropping under *sustained* backpressure stays the deliberate outcome — unbounded growth inside a worker process is the worse failure.

**SDK 1.23 made `Activity.Info.workflowExecution` optional**, because standalone Activities — started directly by a client, with no workflow above them — landed in the meantime. Eight call sites read `workflowExecution.runId` / `.workflowId` for correlation identity. Nothing here starts a standalone Activity, so each now takes the same path it already had for "no activity context": the five `readRunId`-style helpers return `null`, `getActivityContext()` and `currentExecution()` return `null`, and the agent-reply notification skips rather than inventing a dedupe key that would let duplicates through. No behaviour changes for activities started by a workflow, which is all of them.

The OpenTelemetry v1 island is gone from the lockfile — no `@opentelemetry/core`, `resources` or `sdk-trace-base` resolves to a `1.x` version any more — so the `GHSA-8988-4f7v-96qf` dismissal it required is retired from `osv-scanner.toml` and moved to the removed-dismissals table in `SECURITY.md`. That advisory was dismissed on the grounds that the vulnerable `W3CBaggagePropagator` was never constructed from the v1 copy; it is now simply not installed.

Replay determinism was the risk to clear on a bump this wide. Validated locally against 367 freshly fetched dev histories across 29 workflow types, and CI's replay job ran too — its filter is `packages/temporal/src/**`, not `src/workflows/**` as the CLAUDE.md note says, so the telemetry and activity edits in this PR matched it. Worth knowing for next time: a bump that touched *only* manifests and the lockfile would not have matched that filter, and would need the local run on its own.
