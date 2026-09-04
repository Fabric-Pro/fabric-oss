---
"fabric-app": patch
---

Stop the OpenTelemetry shutdown flush from logging an error when the local OTLP collector has already been torn down

Fizzy #2398. On container shutdown the agent containers were emitting
`[Observability] Shutdown error: Error: 14 UNAVAILABLE: No connection
established. Last error: Error: connect ECONNREFUSED 127.0.0.1:4317` on stderr.
The local OTLP collector is torn down alongside the application container, so a
final flush arriving after it has gone is expected and unactionable — but it
landed as an error-level line in front of every production log triage pass, for
every agent service, on every restart, scale-down and redeploy.

`packages/observability/lib/init.ts` now classifies the failure instead of
downgrading the whole catch: a gRPC `UNAVAILABLE` status or an
`ECONNREFUSED`/`ECONNRESET`/`EPIPE` socket code — matched on the structured
`code`, on the message text (which is where the OTLP gRPC exporter actually puts
the status), and through `cause`/aggregate chains with a depth bound — is
reported on stdout at info level. Every other shutdown failure keeps its
error-level line and stack, so a genuine bug in the shutdown path is still
visible.

The match is deliberately shape-aware rather than a substring test, so the
downgrade stays narrow: the status has to appear as gRPC renders it
(`14 UNAVAILABLE:`) and a socket code as Node renders it (`connect
ECONNREFUSED ...`), an aggregate qualifies only when every member does, and
`ENOTFOUND` is excluded because a name that never resolved is a misconfigured
endpoint rather than a collector that shut down first.

Two related fixes in the same path: the logger provider and the SDK now settle
independently via `Promise.allSettled` rather than sequentially, so a rejected
log flush no longer cancels the trace/metric flush and two exporter timeouts no
longer stack back to back inside the container's termination grace period; and
`shutdownObservability()` clears `isInitialized` even when a flush failed,
instead of leaving the singleton looking live after teardown.

Covered by nine new cases in `packages/observability/__tests__/init.test.ts`,
including the verbatim production error string.
