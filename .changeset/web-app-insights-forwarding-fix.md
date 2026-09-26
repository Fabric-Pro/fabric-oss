---
"fabric-app": patch
---

Fix web app logs and RPC failures never reaching Application Insights, and fix the reported AppRoleName defaulting to "unknown_service".

Two independent bugs. On staging (build 7b8dbc82), no web app records arrived at all; the fix for both was verified end to end in a local Next.js runtime, where records then arrived under the right role.

1. `@repo/logs`'s logger and `@repo/observability`'s Application Insights client held their state in per-module-instance variables. Next/Turbopack can compile `apps/web/instrumentation.ts` and its route handlers into separate module instances, so the sink `register()` wired up in `instrumentation.ts` was never the one route handlers actually logged through. A 14-minute poll of the staging Log Analytics workspace found zero records from the web app, although Vercel runtime logs showed the warnings being logged. Both modules now keep their state on `globalThis` under a `Symbol.for` key, so every module instance in a process shares the same logger, sink registry, and Application Insights client.

2. The AppRoleName reported to Application Insights was set via `client.context.tags[cloudRole]`, which the installed SDK (3.15, OTel-based) ignores entirely for AppRoleName — confirmed by direct probing against an isolated client, both before and after `initialize()`. Every record therefore showed up under `AppRoleName = "unknown_service:...node.exe"`. The role is now set via `client.config.azureMonitorOpenTelemetryOptions.resource` (an OTel `Resource`, from `@opentelemetry/resources`' `resourceFromAttributes`) before `initialize()`, which is what the SDK's `TelemetryClientProvider` actually reads.

Because the Application Insights client is now shared between the burn-rate-alerts path and the log-forwarding path, and AppRoleName is fixed at `initialize()` time, the client is transparently recreated (with the stale one shut down) whenever the desired role changes after a client already exists — for example when `initAppInsights()` creates a client before `initAppInsightsLogs()` supplies the real role.

`addLogSink` now takes an optional `id`; re-adding the same id replaces the sink rather than adding a duplicate reporter, which is what makes wiring safe across a module re-evaluation. `apps/web/instrumentation.ts` passes `"app-insights"`.
