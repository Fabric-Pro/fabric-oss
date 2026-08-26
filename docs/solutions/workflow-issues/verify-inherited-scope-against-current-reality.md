---
title: "Verify inherited scope against the current tree before acting on it"
date: 2026-07-21
category: workflow-issues
problem_type: workflow_issue
component: development_workflow
applies_when:
  - "Picking up an approved batch of follow-up items from an earlier PR, audit, or ticket"
  - "Executing a plan whose scope was written against a pre-merge snapshot of the code"
  - "Applying a code-reviewer's suggested fix, especially one flagged pre-existing or out-of-scope"
  - "Any task where the stated scope was authored before the code it targets reached its current state"
tags: [workflow, scope, follow-up, verification, code-review, wcag, accessibility, tests]
audience: engineers scoping follow-up work or acting on review findings
owner: web app team
---

# Verify inherited scope against the current tree before acting on it

## Context

Scope is almost always *inherited* from a document written at an earlier moment: an approved list of follow-up items, an audit doc, a plan's requirements, a reviewer's suggested fix. Each of those reflects the tree as it was **when the document was written** — not as it is now. Between then and now, a PR merged, a migration ran, or another change moved the ground. Acting on the stated scope without re-checking it against the current tree wastes effort re-doing done work, or introduces a regression the stated scope never anticipated.

This surfaced twice in one piece of work (the tooltip accessibility follow-ups):

1. A manager approved four follow-up items. Verifying each against `master` first found **two were already resolved** by the PR that had since merged — a light-mode contrast token had already shipped, and the headline "98 non-focusable tooltips to fix" was a **phantom**: the migration that followed the audit had applied the `sr-only` / `role="img"` remediation inline, so a triage found *zero* genuinely-broken sites remaining. The audit doc had captured the *pre-migration* state; its line numbers and its "98-site sweep" framing were stale.

2. A code reviewer flagged a pre-existing WCAG 2.5.3 issue and suggested a one-line `aria-label` fix. Applying it on a "bias to act" impulse **broke three tests** — the change altered the button's accessible name, and the tests asserted the old name. The reviewer had explicitly called it *pre-existing and out-of-scope*; the tree (via its tests) confirmed it.

## Guidance

**Before executing inherited scope, spend the cheap verification pass that confirms each item is still real.** Concretely:

- **For an approved follow-up batch:** check each item against the current default branch, not the document that listed them. `git log`/`git grep` the merged tree for the fix; if it's already there, drop the item and say so. A brainstorm/plan step that re-verifies scope pays for itself the moment one item turns out done.
- **For a plan written pre-merge:** treat its file:line references and counts as stale hints, not facts. Re-derive them against the current tree (the audit that said "98 sites" was describing a state two migrations ago).
- **For a reviewer's suggested fix:** run the affected tests *after* applying it, before trusting it — especially anything the reviewer marked pre-existing or out-of-scope. A green suite is the tree telling you the change fits; a red one is it telling you the stated scope was a snapshot. Revert rather than weakening the test to match.

The unifying rule: **a stated scope is a claim about a past tree; verify it against the present one before you act.**

## Why This Matters

The failure modes are asymmetric and both expensive:

- **Phantom work** — re-doing something already merged — is pure waste, and worse, it can *conflict* with the real merged version and reintroduce a bug. Half of an "approved" batch being already-done is not unusual when the batch was queued behind other merges.
- **Acting on stale scope** — applying a fix the current tree doesn't want — introduces a regression the stated scope never covered. The `aria-label` swap looked like a clean a11y win in isolation; only the tests knew it changed a contract they enforce.

The cost of the verification pass is minutes (`git grep`, one scoped test run). The cost of skipping it is measured in re-done work, merge conflicts, or a reverted regression. This is the compounding move: the verification turns an inherited document from an authority into a *hypothesis*, which is what it actually is.

## When to Apply

Apply whenever scope is inherited rather than authored fresh in the current session:

- Follow-up tickets/batches approved before the intervening PRs merged.
- Plans, specs, or audits whose body predates the code's current state.
- Reviewer findings, particularly `pre_existing: true` or "out of scope" ones — treat the suggested fix as a hypothesis the test suite adjudicates.

Do **not** skip it because the source is authoritative (a manager approved it, a plan mandates it, a reviewer with high confidence flagged it). Authority speaks to *intent*, not to *current state*. Verification is about state.

## Examples

**Phantom follow-up — caught by verifying against `master`:**

```
# The audit said "98 non-focusable tooltips to fix."
# Verify one flagged site against the current tree first:
$ git grep -n "sr-only" apps/web/.../BacklogAuditDialog.tsx
# → the sr-only remediation is ALREADY present (merged inline with the migration).
# Triage of 30+ flagged sites → 0 genuinely-broken remaining. The "sweep" was a phantom.
```

**Native `title` → `aria-label` is not a safe swap (the specific trap behind example 2):**

`title` and `aria-label` do different jobs, so swapping them silently changes the accessible name — which breaks both WCAG 2.5.3 (Label in Name) *and* any test asserting that name:

```tsx
// Element already has visible text "Type filter" and a title.
// `title` is only a FALLBACK for the accessible name → name stays "Type filter".
<button aria-label={`${label} filter`}>…</button>          // name: "Type filter"

// Adding the active summary REPLACES the accessible name:
<button aria-label={activeCount > 0                         // name: "Type filter: Bug"
  ? `${label} filter: ${summary}`
  : `${label} filter`}>…</button>
// getByRole("button", { name: "Type filter" }) now fails — the test caught the contract change.
```

Decision order when removing a native `title`: element already has visible text naming it → tooltip, **no** `aria-label`; icon-only interactive → tooltip **and** `aria-label`; non-interactive → tooltip **and** an `sr-only` child. See `fabric/standards/frontend/tooltips.md` for the full rule. The meta-point for this doc: the tests were the current tree's verdict on an inherited suggestion — trust them over the suggestion.

## Related

- `docs/solutions/design-patterns/remapping-theme-tokens-on-an-inverted-surface.md` — the Stage 1 tooltip work whose merge made two of these follow-ups phantom.
- `fabric/standards/frontend/tooltips.md` — the `title`/`aria-label` decision order and the four native-`title` exceptions.
