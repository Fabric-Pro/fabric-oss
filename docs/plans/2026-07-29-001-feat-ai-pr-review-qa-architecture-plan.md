---
title: AI PR Review with QA and Architecture Perspectives - Plan
type: feat
date: 2026-07-29
topic: ai-pr-review-qa-architecture
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: card-1642
execution: code
audience: Engineers implementing or reviewing AI PR review; PM re-scoping card 1642
owner: Fabric platform
---

# AI PR Review with QA and Architecture Perspectives - Plan

Card 1642. **Read the premise section first** — the card is written as an
enhancement and it is not one.

## The premise is false, and that is the plan's first deliverable

Card 1642 says:

> Enhance Fabric's **existing** AI PR review capability to include QA-perspective
> checks … going beyond the current narrow implementation-focused review.

There is no existing AI PR review capability. Verified four ways:

| Claim | Reality |
|---|---|
| `code_reviewer_agent` prompt exists | It does — and appears **only** in `seed-prompts-only.ts:2589`. Nothing consumes it. |
| A code-reviewer workflow exists | `workflow-templates.ts:36-42` has it **commented out**, under a literal `// Future templates` heading. |
| A reviewer agent preset exists | `agent-core/src/fabric/index.ts:777` — marked `@deprecated`. |
| `codeReviewer` agent template exists | `seed-agent-templates.ts:299` — a user-instantiable **chat persona**, not a PR-triggered pipeline. |

The originating SDET assessment agrees, in its own words: *"qa-reviewer does not
exist in the current methodology"*, *"none is an architecture reviewer"*, and
*"/code-review is an available skill, not a mandatory step"*. It lists the
`qa-reviewer` persona, the QA rubric and an `ai-review.yml` workflow under
**"what gets built in this phase — none of these exist today"**.

So this is greenfield, and should be estimated as such.

## Scope decision taken

The assessment describes **Fabric's own engineering process**. The card says
results are *"surfaced in the Fabric UI"*, which is a **customer-facing product
feature**. These are different builds and were explicitly disambiguated:
**this plan is the product feature** — Fabric reviews pull requests in a
*customer's* connected repository and shows findings in *their* project.

If the internal-process version is also wanted, it is a separate piece of work
and should get its own card.

## What already exists to build on

This is the part that makes the estimate tractable — very little is from zero:

| Capability | Status | Reuse |
|---|---|---|
| Repository connection + credential | Shipped | `ProjectRepositoryIntegration`; ADR-014 — QA already reuses it, so PR review can too |
| Findings model with file/line/remediation | Shipped | `TestFinding` — merge, dismiss, promote-to-bug all exist |
| Inbound webhook surface | Shipped | `/api/webhooks/github/push` and `/api/webhooks/qa/[projectId]`; secret verification, replay, dedupe patterns established |
| Editable LLM prompt bindings | Shipped | Prompt Library binding + seed + agent-target join — **never hardcode a prompt** |
| Durable long-running work | Shipped | Temporal; the QA agentic runner is the closest analogue |
| Code index over the repo | Shipped | Atlas — the architecture lens needs it for dependency/cycle analysis |
| Per-project QA depth | Shipped | `ProjectQaSettings.strategyDepth` — the card asks the review to respect it |

## Phases

Each phase merges independently and is useful on its own. **Do not build phase 3
before phase 2 is in front of a real user** — the whole risk in this feature is
finding-quality, and the card sets a hard bar (<20% false positives) that cannot
be assessed from an empty pipeline.

### Phase 1 — Ingest a pull request and show it

Deliberately does no AI at all.

- `PullRequestReview` model: project, repo, PR number, head/base SHA, state,
  timestamps, tenant XOR columns, RLS, `tenant-db.ts` registration (both places).
- Fetch the PR and its diff through the existing repository credential. Bound the
  diff — a 10k-file PR must not be loaded whole.
- Trigger: **manual first** ("Review PR #123"), not a webhook. A manual trigger
  is testable, cheap, and defers the webhook-registration question entirely.
- UI: a list of reviewed PRs and one detail view showing the diff summary.

**Exit criterion:** a person can point Fabric at a real PR and see the diff
Fabric read. No findings yet.

### Phase 2 — The QA lens

- Seeded, editable prompt binding (`pr_review_qa`) + agent-target join. Never
  inline.
- Inputs: the diff, the linked feature's acceptance criteria, and the project's
  existing test cases.
- Output: findings with file, line, description, and a **specific** remediation —
  the card's AC4 requires all four, and a finding without a remediation is the
  most common way this class of feature becomes noise.
- Checks: changed code without test coverage; an acceptance criterion with no
  corresponding test; regression risk in touched paths.
- Respect `strategyDepth` — a light project gets a lighter QA review (card
  requirement, and the mechanism already exists).
- Bound the model output budget explicitly. Every `generateObject` in the QA path
  now does; this must not be the exception.

**Exit criterion:** run it over 20 real merged PRs and measure the false-positive
rate against the card's <20% bar **before** building phase 3.

### Phase 3 — The architecture lens

- Second seeded binding (`pr_review_architecture`).
- Checks: design-pattern compliance, dependency risk, circular dependencies.
- Circular-dependency detection should be **computed, not asked** — it is a graph
  problem with an exact answer, and asking a model to infer it invites confident
  wrong answers. Use the Atlas index.

### Phase 4 — Configuration and automation

- Per-project independent toggles for the QA and architecture layers (card
  requirement: enable/disable each **independently**).
- Optional webhook trigger for review-on-open. Note ADR-011: **Fabric does not
  register provider webhooks on a customer's behalf** — the customer configures
  it, exactly as with QA results.

## Decisions the PM still owns

1. **Blocking or advisory?** The card never says. A review that can block a merge
   is a different product — and a different risk — from one that comments.
2. **Which providers at launch?** GitHub only, or GitHub + GitLab + ADO? Each is
   a separate diff API and a separate PR model.
3. **Cost ceiling.** A large PR reviewed by two lenses is a substantial per-run
   spend. Is there a per-project cap, and what happens when it is hit?
4. **What counts as a false positive** for the <20% bar, and who measures it? The
   card sets the target without defining the measurement.

## Risks

- **Finding quality is the whole feature.** A reviewer that cries wolf gets
  switched off in a week, and the card's own success criterion is a
  false-positive rate. This is why phase 2 gates phase 3.
- **Diff size.** Real PRs are occasionally enormous. Bounds belong in phase 1,
  not retrofitted after the first timeout.
- **Not the same as the internal Model 2.** If someone expects `ai-review.yml`
  gating Fabric's own PRs, this plan does not deliver that.
