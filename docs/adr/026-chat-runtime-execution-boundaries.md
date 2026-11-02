# ADR-026: Chat runtime execution boundaries

Execution ownership and durability for chat clients using the shared agent runtime.

- **Audience**: AI/Backend and web developers
- **Owner**: Agent team
- **Status**: Proposed
- **Date**: 2026-10-31
- **Deciders**: Pending engineering review

## Current availability — 2026-11-01

The system CUGA service is retired. It is no longer advertised or registered by
the [shared runtime](../../apps/web/app/api/agents/runtime/[[...path]]/route.ts)
or the [legacy CopilotKit catalog](../../apps/web/app/api/copilotkit/route.ts).
Its former showcase and registered-agent detail, Try, and chat links show an
unavailable notice with a link back to Agents. Registry discovery excludes only
the retired SYSTEM identities; historical records and custom agents remain.

The six active surfaces in this migration are Library, Sidekick, Weave, Atlas,
Data Analyst, and Research. The CUGA adapter discussion below records the
original proposal, not a currently offered execution path. Retained compatibility
protocols and its rollout flag do not register a runtime agent or restore the
retired service.

## Context

Fabric's chat surfaces have different execution lifetimes. Direct, Orchestrator,
and Research use Temporal workflows with saved turns and workflow controls.
Library answers, Sidekick suggestions, Weave refinement, and Atlas answers
already execute within their request handlers. CUGA and Data Analyst call
existing remote agents.

[ADR-001](001-temporal-only-dynamic-agents.md) assigns dynamic agent execution to
Temporal. Its broad consequence that all agent execution uses Temporal needs an
explicit boundary for fixed product chats. The event-contract work in
[ADR-025](025-versioned-chat-event-contracts.md) also requires that a closed
connection cannot be mistaken for a completed answer.

## Decision

Use the shared AG-UI runtime interface with engines that retain each surface's
execution ownership:

- Direct, Orchestrator, and Research keep Temporal execution, persisted turns,
  and their workflow-specific reconnect, resume, and cancellation controls.
- Fixed Library, Sidekick, Weave, and single-repository Atlas chats use
  `InProcessEngine` adapters around their existing server-side turn helpers.
- CUGA and Data Analyst use request-scoped adapters to their existing remote
  services. The web adapter does not take ownership of the remote execution.

This proposal refines ADR-001's scope for fixed product chats. Dynamically
created agents continue to use its Temporal architecture. It does not introduce
another dynamic-agent framework.

Each adapter validates its forwarded input and resolves the authenticated
organization and resource access on the server before model or agent work.
Runtime and legacy paths reuse the applicable model, billing, authorization,
and audit helpers. Service credentials remain server-side. Data Analyst forwards
only supported text, tool, and chart output rather than arbitrary remote graph
state.

## Alternatives Considered

- Keep separate route contracts for each chat. This avoids migration but retains
  separate client handling of completion, interruption, and refusal.
- Run every fixed chat through Temporal. This provides workflow durability but
  adds persisted execution and worker dependencies to short, request-scoped UI
  interactions that do not currently need resumable workflows.
- Run durable chats in process. This would remove the workflow ownership and
  recovery semantics used by Direct, Orchestrator, and Research.

## Consequences

`InProcessEngine` tracks active work in a process-local map. It provides neither
a distributed lock nor a durable idempotency record. Its `connect` operation
does not replay a response. Clients must treat EOF without a terminal outcome
as incomplete; reconnecting must not silently execute another model request.
Use a durable engine when a product requires recovery across requests or hosts.

Stop and disconnect close the Fabric response and propagate cancellation to
the owned request. Engine deadlines leave room for terminal output or partial
persistence within the hosting route's limit. Already-submitted downstream work
can continue and incur usage. In particular, closing Data Analyst's proxy does
not establish that its remote graph has stopped. Provider cancellation and
platform disconnect propagation require deployed verification.

Temporal turn admission, observation, resume, and Stop retain engine ownership.
A Direct, Orchestrator, or Research client cannot reuse another engine's run key
or settle its live turn. Research can restore a saved report without persisting
the same artifact again.

Each migrated surface has a separate organization-scoped rollout flag, defaulting
to off. Clients select a transport when their chat mounts; engines check their
flag again before admitting work. Legacy routes remain available during rollout.
Removing them is a separate compatibility change.

The implementation boundaries are [InProcessEngine](../../apps/web/modules/saas/agents/runtime/in-process-engine.ts)
and [ResearchEngine](../../apps/web/modules/saas/agents/runtime/research-engine.ts).
