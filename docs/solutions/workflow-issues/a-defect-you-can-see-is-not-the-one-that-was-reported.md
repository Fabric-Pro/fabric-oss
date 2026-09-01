---
title: "A defect you can see in the code is not automatically the one that was reported"
date: 2026-09-01
category: workflow-issues
problem_type: workflow_issue
component: development_workflow
module: living-documents auto-refresh, feature flags, project-documents
severity: high
applies_when:
  - "A bug report is explained by a defect you found by reading code, without checking the reported environment"
  - "The user-visible error names a cause (a provider, a limit, a document) rather than a failure"
  - "A capability is gated in more than one place and the gates look like duplicates of each other"
  - "The evidence that would distinguish two candidate causes is thrown away by the code under investigation"
  - "Reviewing a plan whose diagnosis rests on code reading alone"
tags: [debugging, diagnosis, root-cause, feature-flags, infrastructure, error-messages, code-review]
related_components: [project-documents, feature-flags, temporal, deployment]
audience: Engineers diagnosing a reported bug, and reviewers of a plan that claims a root cause
owner: Fabric platform
---

# A defect you can see in the code is not automatically the one that was reported

## Context

A ticket reported that a document's auto-refresh could not be enabled and that
manual regeneration failed. Reading the code produced an immediate, satisfying
explanation: the capability was gated twice, by two different variables, with
two different parsers, one of them inlined at build time so it could never
change at runtime. Nothing kept them in agreement. Clicking a control that
rendered from one variable against an API that answered from the other would
fail exactly as reported.

Every artifact downstream inherited that story. The plan asserted it. Seven
persona reviewers and four adversarial rounds critiqued the plan without
challenging it — one of them did flag it as an unverified assumption, and it
was recorded as such and then quietly treated as settled anyway.

It was wrong. Checked against the deployment, **both** variables were `true` in
production. Both gates were open. The split could not have caused the report.

The split gate was still a real defect, and it still shipped fixed. But the
thing the ticket was about remains undiagnosed, and the fix that will actually
find it is the unglamorous one nobody would have prioritised on its own: the
error handler that discarded the server's message.

## Guidance

### 1. A defect that explains the symptom is a hypothesis, not a diagnosis

The strength of "this code is broken, and being broken it would produce exactly
this symptom" feels like proof. It is not. It establishes that the defect is
*sufficient* to cause the report, never that it is *actual*. The gap between
those is the whole risk, and it closes only against the environment the report
came from.

Before writing a root cause into a plan, name the observation that would
falsify it, and go and make that observation. If it cannot be made — no access,
no logs, no reproduction — then the plan says *hypothesis*, and the acceptance
criteria that depend on it stay open.

### 2. Two candidate causes are only distinguishable if something records the difference

Here the discriminator was one HTTP status. A capability gate that is off
answers `NOT_FOUND`; a caller without permission gets `FORBIDDEN`. Both produce
the same user-visible sentence, because the client did this:

```ts
// The error is bound and then never used. Both causes collapse to one string,
// and the one datum that separates them is gone before anyone can read it.
onError: (_err, _next, context) => {
    rollback(context);
    toast.error("Could not update auto-refresh for this document.");
},
```

Two weeks of investigation had nothing to work from but that sentence. Which
gives the practical rule: **when a surface swallows the distinguishing evidence,
restoring it is not a nicety to bundle with the real fix — it often IS the real
fix**, because it is what converts the next occurrence from a guess into an
observation.

### 3. Two gates on one capability may not be a duplicate — check what each is FOR

The two variables looked like one flag read twice. They were not. The
infrastructure said so plainly, in a file no application-code reviewer opens:

```
@description('... TRUE in every environment, prod included — this is
deliberately NOT the rollout switch. Rollout is owned solely by the web app\'s
own copy of the flag: with it off nobody can enroll a document. What this param
buys is the kill switch — the worker re-reads the flag immediately before it
writes, so setting it false stops an AI mid-rollout. Set false only to hit the
brakes.')
param enableLivingDocsRefresh bool = true
```

One was the accelerator; the other was the brake. Merging them into a single
flag would have converted an always-armed brake into a feature that launches on
deploy — the exact opposite of the intended fix, arrived at while believing the
merge was a cleanup.

So before collapsing two gates into one, answer for each: what does turning
this OFF stop, and who turns it off? If the answers differ, they are two gates.
Keep them separate and make the dangerous half require the safe half — a brake
must never be able to drive.

### 4. The evidence may not be in the repository

The deciding facts in this incident were: the values of two environment
variables in a hosting dashboard, and a comment in a deployment template. Both
outside the application code, both invisible to a reviewer reading a diff, and
between them they overturned a conclusion that eleven reviewers had left
standing.

When a diagnosis turns on configuration, extend the search to where
configuration actually lives — deployment templates, infrastructure-as-code,
the hosting provider's own settings, and the comments in all three. A
deployment template's prose is design documentation that no code search will
surface.

## Why This Matters

The cost of a confident wrong diagnosis is not the wasted work. It is that
**everything downstream inherits it and stops looking.** In this case the wrong
story propagated into a requirements document, an implementation plan, four
adversarial gate rounds, eleven reviewers, and a changeset — and none of them
re-examined the premise, because each was reviewing whether the plan was a good
plan *for that story*.

Note the symmetry with the bug itself: the user-visible error named a cause
("the document is too large", "AI provider not configured") that was not the
failure, and everyone who read it went looking in the wrong place. The
investigation then did the same thing one level up. **A confident wrong cause is
more expensive than an admitted unknown**, whether it is written by an error
message or by an engineer.

## When to Apply

- Any time a root cause is established by reading code rather than by observing
  the failing environment — most sharply when the reading is elegant.
- When the reported symptom is a generic message that several distinct causes
  could produce.
- Before merging, renaming, or collapsing anything that gates a capability,
  particularly when one of the gates lives in infrastructure.
- When reviewing a plan: check whether its causal claim carries an observation,
  and treat "the code would do this" as insufficient. A finding that a premise
  is unverified must block the premise, not merely annotate it.

## Examples

**The claim, as written into the plan:**

> In a working environment the settings read succeeds and the control reflects
> real stored state. The reported failure environment shows the control
> rendering against the component's fallback defaults, which is what a failed
> read produces. The two flags disagree in the failing environment.

Every sentence but the last is an observation. The last is an inference, and it
is the one the whole plan rested on.

**The same claim after the observation was actually made:**

> Flag drift is the leading explanation — but a permission denial produces the
> identical symptom, because the permission middleware runs before the flag
> check and the component discards the error. The discriminating evidence is the
> error code from the settings read: `NOT_FOUND` means the capability is off,
> `FORBIDDEN` means permission. Until it is observed, treat both as live.

**And after checking the deployment:** both variables were `true`, so neither
arm of that disjunction was the drift. The rewrite is not a hedge — it is the
version that survives contact with the environment, and it names what to go and
look at next.

## Related

- `docs/solutions/workflow-issues/verify-inherited-scope-against-current-reality.md`
  — the same failure one step earlier: acting on a scope figure inherited from
  an older snapshot without re-deriving it. Both are cases of trusting a
  statement about reality over reality.
- `docs/solutions/design-patterns/a-surface-must-not-report-absence-it-did-not-verify.md`
  — "a crash is investigated, a confident false negative is believed", the same
  asymmetry applied to what a surface reports rather than to what an engineer
  concludes.
- `docs/solutions/integration-issues/ai-assistant-codebase-availability-misreport.md`
  — prefer a discriminated state over a boolean when a message must distinguish
  "why not"; the mechanism that would have preserved the evidence here.
