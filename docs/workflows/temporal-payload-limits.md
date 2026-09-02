# Temporal Payload Size Limits

Why large data-gathering flows hit a hard ceiling, and how Fabric bounds payloads so they
degrade or fail loudly instead of stalling.

- **Audience**: engineers writing Temporal activities, workflows or signals
- **Owner**: Fabric platform team
- **Tickets**: Fizzy #1997 (this work), Fizzy #1741 (the production incident that exposed it)

## Determination and status

Earlier guidance described this as a self-hosted-only limitation that could not be resolved.
Both halves of that turned out to be wrong, and this section is the correction.

**The limit applies to Fabric's production environment.** It is not confined to self-hosted
deployments. The ceiling is enforced client-side by the Temporal Rust core, so it is
identical on Temporal Cloud and self-hosted, and no configuration on either raises it.

**It is not raisable, but it is mitigable.** The ceiling cannot be moved, so the resolution
is to bound what crosses each boundary rather than to ask for more room. That work has
shipped: payloads now degrade (content capped, summaries slimmed) before they fail, and when
they must fail they name the boundary instead of surfacing as an unexplained timeout.

Bounded and verified: PM work-item listing (including the per-column and REST paths), MCP
tool results, daily-brief collectors, and chat retry history. The accepted limits are listed
under [Known limits](#known-limits) — most notably that the story *push* direction fails fast
rather than chunking.

## The limit

Every message crossing the Temporal gRPC boundary is capped at **4,194,304 bytes (4 MiB)**.
This applies to activity inputs and outputs, child-workflow arguments and results, signals,
queries, and heartbeat details.

The cap is enforced **client-side, by the Rust core** inside `@temporalio/core-bridge` — not
by the server. Two consequences follow, and both are frequently assumed the other way:

- **It is identical on Temporal Cloud and self-hosted.** It is not a Cloud quota, and it is
  not something a self-hosted deployment escapes by configuring its own frontend.
- **`limit.blobSize.*` dynamic config does not move it.** That setting governs server-side
  blob limits; the gRPC frame is separate. On Cloud there is no knob at all.

Fabric's deployed environments run Temporal Cloud (`aspire/Fabric.AppHost/Program.cs` wires
API-key auth); local development runs self-hosted `temporalio/auto-setup`. The ceiling is the
same in both, which is what makes the local reproduction meaningful.

## What the failure looks like

This is the part worth memorising, because the symptom does not name the cause.

The activity completes successfully. Its return value is then rejected when the core tries to
send it, and the core logs:

```
ResourceExhausted: grpc: received message larger than max (6482333 vs. 4194304)
```

Temporal retries the activity, which produces the same oversized result, until the retry
policy is exhausted. What is recorded in workflow history — and what you see in the UI — is a
**StartToClose timeout**. Nothing in that history mentions size. In #1741 this presented as a
flow that silently stalled partway through.

Oversized activity *inputs* behave differently: they are rejected at scheduling time, before
the activity body runs. An assertion inside the activity can therefore never observe them.
**A bound on an input has to live in the caller.**

## How Fabric bounds payloads

The strategy is targeted bounding at each boundary, not a global compression codec. A codec
would shrink everything for free, but it renders payloads unreadable in Temporal Web without
a codec server — and reading history is how the #1741 investigation was actually done. It
also does not bound the worst case; an incompressible payload still fails.

Two shared modules carry the mechanics:

| Module | Purpose |
|---|---|
| `packages/temporal/src/lib/payload-size-guard.ts` | Measure serialized size; warn at 2 MiB; throw `PayloadTooLargeError` past the hard budget (frame minus 64 KiB headroom) |
| `packages/temporal/src/lib/payload-elision.ts` | Degrade before failing — cap description fields down a ladder, drop nulls, slim work-item summaries, truncate oversized tool text |

The ordering is deliberate: **degrade first, fail loudly second, never silently truncate.**

Bounded boundaries today:

- PM work-item listing (`activities/pm-integration/story-sync.ts`) — paged and per-column
  paths, plus the GitLab REST branch
- MCP tool results (`activities/orchestrator/execution/execute-mcp-tool.ts`) — bounded at the
  single exported wrapper exit, so every implementation return path is covered
- Daily-brief collectors (`activities/daily-brief/*`) — row caps, newest-first
- Chat retry history (`packages/api/modules/ai/procedures/retry-failed-message.ts`)

## The rule that is not about size

`truncateMcpTextOutput` refuses to cut JSON-shaped text, and an unparseable work-item page
throws rather than returning an empty list.

This is a data-loss guard, not a size optimisation. A full PM pull treats "no cards returned"
as "the board is empty" and deletes every synced story whose remote id is absent. A payload
truncated mid-JSON, or a column whose response failed to parse, both look exactly like an
empty board. Cutting one open would delete real work.

**If you add a parser on a listing path, an unrecoverable response must throw.** Returning
`[]` is the dangerous default.

## Known limits

These are deliberate, not oversights:

- **The push direction fails fast rather than chunking.** A project whose serialized story
  bodies exceed the frame cannot complete a push; it fails with a named boundary instead of a
  timeout. Chunking it requires workflow-orchestration changes and a replay surface.
- **Chat history and daily-brief sections cross as inputs**, so they carry size diagnostics
  (warn at 2 MiB) rather than a hard bound. Collector row caps bound the daily brief in
  practice.
- **A single item larger than one frame cannot be chunked across messages.** The guard names
  the boundary and fails; that is the intended outcome.
- **Elided item bodies can persist** as story content where no per-item fetch tool exists. The
  elision marker keeps this visible and triggers a re-fetch on a later pass.

## Adding a new boundary

1. Measure with `measureSerializedBytes` where bulk crosses the boundary.
2. Degrade with the elision helpers before considering failure.
3. Assert with `assertPayloadWithinLimit`, passing a label that names the boundary — the label
   is what turns a future incident into a five-minute diagnosis.
4. If you are bounding an **input**, put the bound in the caller. An assertion in the activity
   body will never run.
