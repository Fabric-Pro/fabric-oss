---
title: "An abort signal is not a deadline — bound the await yourself, race the cancellation too, and check it again before you write"
category: architecture-patterns
date: 2026-10-16
module: proposal internal analysis report call (packages/temporal analysis activity)
problem_type: architecture_pattern
component: background_job
severity: medium
applies_when:
  - "An activity awaits a provider call (model, HTTP, SDK) inside a fixed time window and must still persist other work when that call runs long"
  - "The call takes an AbortSignal, but nothing proves every adapter behind it honours the abort"
  - "A cancelled activity must neither hold its worker slot until a timeout nor complete the run"
tags: [temporal, abort-signal, deadline, cancellation, promise-race, timeout, activity, ai-sdk, heartbeat]
related_components: [service_layer]
---

# An abort signal is not a deadline

## Context

After an analysis activity has its findings, it makes a second, optional model call for a report, with its own deadline inside the activity's ten-minute start-to-close window, so the findings are always saved in time. The first version passed `requestAbortSignal(remainingMs)` (a timeout joined with the activity's cancellation signal) to `generateText` and awaited the call inside `withHeartbeatTicker`. Two adversarial review rounds then showed that the abort signal only *asks* the call to stop:

- A provider adapter that ignores the abort leaves the awaited promise unsettled. The heartbeat ticker keeps the activity alive until start-to-close fires, and the findings are never written.
- Racing the call against a deadline timer fixed that, but activity cancellation still could not settle the race, so a cancelled activity held its worker slot for up to eight minutes.
- With cancellation in the race too, a call that had *already resolved* still won the race over an earlier cancellation (the call is listed first), and the success path wrote the run as COMPLETE from a cancelled activity.

## Guidance

Treat the abort signal as a request and own the bound (`settleWithin` and `throwIfCancelled` in `packages/temporal/src/activities/proposal-artifact/analysis.ts`):

1. **Race the call against an independent timer** set to the same remaining time; when the timer wins, map it to the timeout outcome (here `timed_out`, findings saved without a report). Tell the timeout apart by identity (a sentinel error), not by message or name.
2. **Race the activity cancellation signal as its own rejection**, rejecting at once if it is already aborted, so cancellation ends the wait immediately rather than at the deadline.
3. **Clean up every side in `finally`**: clear the timer (and `unref` it so it never keeps the process alive) and remove the abort listener.
4. **Attach a no-op `catch` to the call before racing**, so the abandoned call's late rejection is never unhandled.
5. **Check cancellation again after the call resolves** and before parsing or persisting anything, and once before starting the call, so a provider that ignored the abort and answered anyway cannot complete a cancelled activity.

## Why This Matters

The point of the deadline was a guarantee: the required work (findings) is persisted before the activity's own timeout. A guarantee that depends on every adapter honouring abort is not one; it degrades exactly when a dependency misbehaves, and then fails the required work too (the activity times out and retries, repeating both model calls). The same holds for cancellation: a cancelled attempt should release its slot and must not write.

## When to Apply

Any activity or request handler that awaits a third-party call within a budget and has work to persist afterwards, especially when the call goes through several adapters (provider SDKs, gateways, middleware) whose abort behaviour you do not control.

## Examples

Directional sketch of the shape (not the full implementation):

```ts
call.catch(() => {}); // the loser may reject later
const answer = await Promise.race([call, deadlineTimer, cancellationRejection]);
// finally: clearTimeout(timer); signal.removeEventListener("abort", onAbort);
throwIfCancelled(signal); // a cancelled activity never persists
```

Tests that pin it (activity test, "a call that ignores the abort"): a provider promise that never settles and ignores abort completes the run at the deadline with findings and `timed_out`; a cancellation while it hangs rethrows at once with no timers or listeners left; a provider that resolves after cancellation does not complete the run; a call that settles first clears the timer and the listener.
