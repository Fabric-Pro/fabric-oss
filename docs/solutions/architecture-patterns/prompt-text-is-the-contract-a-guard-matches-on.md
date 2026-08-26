---
title: "Prompt text is the contract a guard matches on"
date: 2026-08-03
category: architecture-patterns
problem_type: architecture_pattern
component: ai_prompts
applies_when:
  - "Editing the wording of a prompt that tells a model how to structure a work item body"
  - "Writing or changing a guard that inspects model output for section headings"
  - "Adding a prompt record whose text reaches a shared system prompt"
  - "Assuming a prompt change is cosmetic because no code changed"
tags: [prompts, structure-guards, ai, work-items, invariants]
audience: engineers changing prompt text or the guards that read model output
owner: web app team
---

# Prompt text is the contract a guard matches on

## Context

`detectDestructiveRewrite` protects a bug's body from being rewritten into feature shape. It counts how many of six canonical section names appear in the existing body and in the candidate rewrite, and refuses when a body that had them comes back with none.

The backlog analyzer produces bug proposals. Its instructions described the diagnostic sections as inline bold labels — `- **Steps to Reproduce**: …` — under two names the guard does not carry (`Expected Behavior` / `Actual Behavior` rather than `Expected Result` / `Actual Result`).

## What went wrong

The guard scored those bodies **zero**, because `countHeadingMatches` only counts lines matching `/^#{1,6}\s/`. A bold label is not a heading. So the protection existed, was tested, and could never fire for anything the analyzer produced — and nothing failed, because a guard that never arms looks identical to a guard that never needed to.

Two things follow.

**A prompt edit is a behaviour change with no diff in the code that depends on it.** The guard's canonical names are documented as taken from the seeded creation prompt; the analyzer was written separately and drifted. Nothing linked them, so nothing caught the drift.

**Fixing the wording fixes it only where you fixed it.** There are two producers of bug proposals. Correcting the temporal analyzer left the LangGraph backlog-updater still emitting the old bold-label form under the old names, so the guard stays blind to everything that producer makes.

## The rule

When a guard reads model output, the prompt that shapes that output is part of the guard's contract. Treat a wording change to either side as a change to both:

- **Derive, do not restate.** If a guard matches on section names, the prompt should be the documented source of those names and the test should assert the pair, not each half separately.
- **Enumerate the producers.** Grep for every prompt that instructs the same output shape before declaring a format fixed. One producer fixed is not the format fixed.
- **Assert the guard arms, not just that the names appear.** The useful assertion is that `detectDestructiveRewrite` scores a real body above its threshold — that exercises the matcher, the heading level, and the names together. Asserting the names alone passes on a body the matcher cannot see.

## The sharp edge

`countHeadingMatches` matches by **substring**. A rewrite containing any heading that merely contains one of the canonical words — `## Business Impact` contains `Impact` — scores 1, which is enough to defeat a guard condition written as "the candidate has zero". A fix that relies on `candidateSig === 0` is therefore weaker than it reads.

That is worth knowing before writing the next guard: substring matching makes false *positives* cheap and false *negatives* silent, and the silent direction is the one that drops protection.

## How to verify a prompt change actually landed

Build the test fixture *from the prompt string itself* rather than hand-writing a body that looks right. A test that hard-codes an example body passes whether or not the prompt still says to produce it. Then prove the test is not vacuous by temporarily reverting the prompt and watching it fail — a prompt assertion that cannot fail is the default outcome, not the exception.

## Related

The same change showed the mirror case: two markdown headings a caller writes on the way out and splits the model's reply on when it comes back are load-bearing *data plumbing*, not formatting. Removing one there would have parsed a bug's acceptance criteria as empty and proposed wiping the stored column. Both cases are the same lesson from opposite ends — text that a machine matches on is a contract.
