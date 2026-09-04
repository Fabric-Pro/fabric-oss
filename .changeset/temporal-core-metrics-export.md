---
"fabric-app": patch
---

Export the Temporal SDK's core worker metrics (task slots, sticky cache, schedule-to-start latency) to the OTLP collector so worker saturation is observable.

The worker already pushes its own OpenTelemetry metrics, traces and logs to the collector on `OTEL_EXPORTER_OTLP_ENDPOINT`, and Azure forwards that stream to Application Insights. The metrics emitted by the SDK's native core never joined it: nothing installed the Temporal runtime with an exporter, so the `temporal_*` series (`worker_task_slots_used`, `sticky_cache_size`, `workflow_task_schedule_to_start_latency`, `activity_execution_latency`, …) were never produced at all. In production the worker is a non-HTTP container app with no probe, so a saturated worker was indistinguishable from an idle one.

`installTemporalRuntime()` in `packages/temporal/src/telemetry.ts` now runs during worker boot before `NativeConnection.connect` or `Worker.create` can lazily create the exporter-less default runtime. It points the core's OTLP/gRPC exporter at the same endpoint the Node SDK exporters use, at the same 60 s interval as the existing metric reader. When `OTEL_ENABLED=false` or no endpoint is set it does nothing, matching `initTelemetry()`. The env → options mapping is a pure function covered by `__tests__/runtime-metrics-options.test.ts`.
