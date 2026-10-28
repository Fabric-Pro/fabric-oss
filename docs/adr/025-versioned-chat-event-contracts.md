# ADR-025: Versioned chat event contracts

Proposed direction for typed chat transport and incremental engine convergence.

- **Audience**: Engineering
- **Owner**: Engineering team
- **Status**: Proposed
- **Date**: 2026-09-28
- **Deciders**: Pending engineering review

## Context

Direct, Orchestrator and Research historically decoded SSE independently and
consumed untyped values inside React hooks. Connection closure can be mistaken for successful completion,
and producer events can lack corresponding consumer handling. Fabric also has
Orchestrator and AG-UI interfaces whose event names and lifecycle contracts differ.

## Decision

Propose schema-derived discriminated event contracts shared by producers and
consumers, transport decoding outside React, and explicit turn outcomes. Introduce
an additive top-level `version: 1` on the existing Direct and Orchestrator SSE objects. Continue
accepting legacy unversioned events during rolling deployment; reject unsupported
versions and malformed known events while tolerating unknown event kinds for
additive evolution. EOF alone cannot complete a reply.

The implementation covers Direct and Orchestrator route producers and Direct,
Orchestrator and Research consumers through one transport reader. Existing
Orchestrator reconnects observe the same run; malformed contracts fail without
reconnecting. Research retains legacy text/completion aliases. This proposal does not create durable event storage. It retains existing
workflow signals and adds the opt-in decideApproval Update as an approval
authority, plus the chatRunContext query for authorization context. Preserve AG-UI at existing agent interfaces. Keep the browser-safe
schemas in the web application until other consumers justify a shared package.

## Alternatives Considered

- Continue using untyped JSON in each hook: permits producer/consumer drift and
  duplicates transport behavior.
- Replace all wire protocols immediately: couples every engine and deployment to
  one migration, including AG-UI consumers.
- Add event types without connecting producers and consumers: provides no runtime
  validation or user-facing reliability improvement.

## Consequences

The Direct and Orchestrator routes declare the event shapes they emit. The browser
validates received events and retains partial text when the transport is interrupted.
Existing clients can still read the unchanged top-level event fields. Validation
failures must avoid logging event bodies because tool results can contain sensitive
content. Future resume support must observe an existing run without automatically
replaying a request that could execute writes again.

The [productization roadmap](../features/agent-productization.md) defines the later
durability, governance and UI milestones and their acceptance gates.

## Opt-in approval Updates

`ORCHESTRATOR_APPROVAL_UPDATES_ENABLED` defaults to off. Only the exact string
`true` enables it, and only web/API starters read it. Deploy this code to all
workers first, then enable the switch on web/API. Workflow input and memo capture
`approvalProtocol: 2` together at start. Existing runs keep their original
protocol even when the switch changes. Workflow child starts remain legacy.

Without that memo value, approval routes submit the legacy pending-ID `approval`
signal; success confirms submission, not workflow acceptance. Protocol-2 runs
served by the new web/API use `decideApproval` Updates and require an accepted
receipt; stale, expired and rejected decisions do not report success. Legacy
web/API versions can still send approval signals to protocol-2 workers through
the legacy-signal adapter.

Before enabling, web/API and workers may roll forward or back independently for
legacy approvals. After enabling, histories that accepted an Update cannot replay
on workers older than this change. To roll workers back past this change, turn
the switch off and let protocol-2 runs finish first. Turning it off does not
convert existing protocol-2 runs to the legacy protocol. Web/API rollback retains
legacy signal-submission semantics and does not remove recorded Update events.
