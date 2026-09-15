---
"fabric-app": minor
---

Engagement profiles and delivery tracks: the backlog now runs the inverted loop where it applies

A project declares how it is run — EXPLORE, PROPOSAL, GOVERNED or DELEGATED —
and that profile sets how work arrives (a conversation or a document), the
default delivery track, how strict the gates are, the Kanban column template
and whether a customer-facing outcomes page is offered. Existing projects are
GOVERNED, the closest match to how Fabric behaved before, so nothing changes
for them until someone changes the profile.

Every work item carries a delivery track: SPIKE (an open question answered by
building), DISCOVERY (touches a system we have to read first), SPECIFY (needs
the document tiers) or DEFER. A classifier proposes the track from the item's
text; a human choice is never overwritten. Readiness before PUBLISHED follows
the track: an accepted spike run, a completed integration contract, the
document tiers, or nothing. Gates are advisory by default and can be enforced
per track per project; turning one on is an audited governance change.

What this adds:

- Scope intake from a customer document (proposal decks, scope tables) into a
  reviewable proposal, with the customer's own line references kept on each
  item and scope areas kept as `area:` labels.
- Conversational intake for EXPLORE projects: the backlog chat opens by itself
  on an empty backlog, asks for the hunch and proposes the first spikes.
- Spike runs: a coding run of kind SPIKE that pushes a `fabric-spike/` branch,
  delivers findings and a demo rendered as a project-scoped frame, and is
  accepted with play notes. A SPIKE item is LOW confidence until then.
- Discovery runs: read the repository, an OpenAPI description or the
  customer's MCP servers and produce an integration contract plus open
  questions as comments. Contract status is owned by the run; the generic
  document update, the v1 API and the MCP tool refuse to change it.
- Governed approvals: under GOVERNED a stage change becomes a request reviewed
  by configured approvers, and every stage write goes through one choke point.
- Estimates by phase with a confidence range, exportable as markdown or CSV.
- Success metrics with manual or signed-webhook observations, a metric-drift
  section in the Daily Brief, and a token-scoped customer outcomes page.

Operational notes: four additive migrations; two workflows changed shape
behind `patched()` gates, so replay a real pre-change implement history
against the new worker before deploying it, and deploy the migrations before
any worker that can write the new coding-run status.
