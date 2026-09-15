# ADR-020: Engagement profiles and delivery tracks govern the backlog, not one uniform spec gate

- **Status**: Accepted
- **Date**: 2026-09-14
- **Deciders**: Engineering team, Product
- **Relates to**: [ADR-018](018-organization-is-the-only-tenant-context.md) — the new tenant-scoped rows follow the organization-only rule
- **Audience**: engineers working on backlog intake, drafting stages, coding runs, discovery, estimates or customer-facing outcomes
- **Owner**: Platform

## Context

Fabric assumed every work item passes through the same sequence: placeholder,
analysis, draft, PRD and technical spec, then a coding run. That fits a governed
engagement with a signed requirements document. It does not fit the other
engagements TechFabric actually runs: a customer with a hunch and no document,
a proposal deck with a hundred scope lines where half the lines are open
questions, or a customer who hands over requirements and expects the team to
decide how to deliver. Forcing all of them through the same document tiers
either blocks work that should start today or produces specs that are fiction.

The a16z article "Product Management is Still All About Telling Stories"
(Elman, 2026) describes the inverted loop: idea, build, play, design, ship,
learn. Fabric needed a way to run that loop where it applies while keeping the
governed path where it is required.

## Decision

**A project declares how it is run (its engagement profile), and every work
item carries a delivery track that decides what evidence it needs before it is
published.**

- `Project.engagementProfile` is one of EXPLORE, PROPOSAL, GOVERNED or
  DELEGATED. The profile sets the intake mode (conversation or document), the
  default track, gate strictness, the Kanban column template and whether the
  customer outcomes surface is offered. Existing projects default to GOVERNED,
  the closest match to the previous uniform behaviour.
- `UserStory.deliveryTrack` is one of UNCLASSIFIED, SPIKE, DISCOVERY, SPECIFY
  or DEFER. A classifier assigns it from the item's text; a human assignment is
  never overwritten by the classifier.
- Readiness before PUBLISHED depends on the track: an accepted spike run for
  SPIKE, a COMPLETE integration contract for DISCOVERY, the document tiers for
  SPECIFY, nothing for DEFER. Gates are advisory by default and enforced per
  track by project flags; turning one on is an audited governance change.
- Every drafting-stage change goes through one choke point
  (`enforceStageTransition` and `writeStage` in `packages/database/src/delivery`).
  Under GOVERNED a transition becomes a `StageTransitionRequest` reviewed by a
  configured `ProjectStageApprover`; nothing writes a stage around it.
- Spikes are coding runs of kind SPIKE that push a `fabric-spike/<runId>`
  branch and deliver findings plus a demo rendered as a project-scoped frame.
  Discovery runs read the customer's systems and produce an
  `INTEGRATION_CONTRACT` document whose status only the run's completion
  procedure may change. A SPIKE item has LOW estimate confidence until a spike
  is accepted, enforced by the write itself.
- Proposal application is idempotent: each row a proposal creates carries a
  `proposalApplicationKey`, and a proposal is claimed with a compare-and-swap
  before it is applied.

## Consequences

- No backend model is renamed. fabric-dev has no Epic or Feature container
  tables, so scope areas from an imported document become an `area:<name>`
  label on the story rather than a container row.
- Governance rows (`stage_transition_request`, `project_stage_approver`) are
  readable by accepted project members as well as the owning tenant, so a
  project-scoped guest can request and, when configured, approve a transition.
- Outbound fetches made on a customer's behalf (discovery runs) resolve DNS
  first and refuse every address that is not globally routable; IPv6 is an
  allowlist of global unicast.
- Two Temporal workflows changed shape behind `patched()` gates
  (`backlog-apply-claimed-finalizer-v2`, `backlog-apply-classify-child-v1`,
  `daily-brief-v4-metric-drift`). Before a worker with this change is deployed,
  replay a real pre-change implement `codingRunWorkflow` history against it.

## Alternatives considered

- **Take the article literally and drop specs.** Rejected: enterprise work
  still needs authentication, tenancy and integration boundaries understood
  before a coding agent runs; the tracks keep that where it applies.
- **A per-project "strictness" slider instead of profiles.** Rejected: the
  profiles differ in intake and surfaces, not only in gate strictness.
- **Hard-enforce the new gates immediately.** Rejected: existing projects would
  have stalled; advisory first, enforcement per track by explicit flag.

The full plan, estimates and implementation notes are in
[`docs/features/inverted-loop-delivery-tracks.md`](../features/inverted-loop-delivery-tracks.md).
