---
title: Living Documents Auto-Refresh, Deferred Scope - Plan
type: feat
date: 2026-07-13
topic: living-docs-auto-refresh-deferred-scope
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
audience: Engineers implementing or reviewing Living Documents auto-refresh
owner: Fabric platform
---

# Living Documents Auto-Refresh, Deferred Scope - Plan

## Goal Capsule

- **Objective:** Preserve the parts of the Living Documents Auto-Refresh narrative that the first slice does not build, each with the specific reason it was deferred, so nothing is lost and the next slice starts from evidence rather than re-discovery.
- **Product authority:** The originating feature narrative (FR1–FR29, AC1–AC20). The shipped subset is `docs/plans/2026-07-13-001-feat-living-docs-auto-refresh-plan.md`; everything the narrative asked for and that plan does not cover is here.
- **Open blockers:** Four of the five items below are blocked on infrastructure that does not exist in the platform today. Each names what would have to be built first. These are findings, not estimates — they were verified against the codebase, not assumed.

---

## Product Contract

### Summary

The narrative describes six capabilities. One — the scheduled refresh cycle itself — is being built now. The other five each depend on a platform capability that the narrative assumed was present and that is not. This document records what each one needs, so the decision to build it is a decision about the dependency, not a rediscovery of the gap.

### Problem Frame

The narrative was written against a mental model of the platform that is accurate in its bones and wrong in four specific places. It states that Slack and Teams notification delivery "already exists in the platform," that a release pipeline emits an event the refresh engine can consume, that project members carry the role tags needed to route a question to the right person, and that feature-flagged code can be identified in a connected repository. None of these hold.

That is not a criticism of the narrative — three of the four are reasonable inferences from things that genuinely exist nearby. Slack and Teams *are* integrated, but for posting newsletters to a channel, not for delivering a notification to a person. Fabric *does* have a Release Notes surface, but it is an aggregation of a text field on features, not a release event. Project members *do* have roles, but they are permission levels, not job functions. The gap in each case is narrow and specific, and it is load-bearing.

The cost of not writing this down is that the next person to pick up the narrative re-runs the same investigation, or worse, does not, and plans against the same four assumptions.

### Deferred Capabilities

Each entry states what the narrative asked for, what exists, what is missing, and what building it would actually mean.

---

**D1. Clarification Needed workflow** — narrative FR16–FR22, AC9–AC14.

*Asked for:* When the AI cannot confidently update an item, it logs a discrete entry in a "Clarification Needed" section of the document, commits the rest normally, surfaces a tab in the document UI, offers AI-generated recommendations as clickable options alongside a free-text field, does not duplicate an unresolved entry across cycles, and treats a resolution as authoritative context for the next cycle.

*What exists:* A generic clarification primitive for the chat orchestrator at `packages/temporal/src/activities/orchestrator/clarification.ts` — it returns whether clarification is needed, a question, options, and reasoning. The shape is exactly right and is reusable.

*What is missing:* Everything around it. There is no persistence for a clarification item, no identity for one (which is what FR21's no-duplicates rule requires — an item must be recognizable across cycles), no resolution state, no UI surface, and no link from a resolution back into the next refresh's context.

*What it would take:* This is the largest of the five and the only one not blocked on a platform gap — it is blocked only on its own size. It is a model, a UI tab, a resolution flow, and a context-injection path. The stable identity for an item is the design crux: without it, FR21 cannot hold and every cycle re-raises the same question.

*Note:* This is the capability that makes the narrative's title honest. Without it, an unattended refresh that encounters ambiguity has no way to say so — it guesses, silently. That is a real quality risk in the shipped slice, and it is the strongest argument for building this next.

---

**D2. Release-triggered refresh** — narrative FR6–FR9, AC6–AC8.

*Asked for:* A production release event triggers an immediate refresh of every enrolled document in the project, additively — without resetting the scheduled cadence.

*What exists:* Nothing that emits a release event. The Release Notes tab is built from `UserStory.releaseNotes`, a text field on a feature — an aggregation, not an event. The GitHub webhook the platform already receives handles push events only, and filters them to the indexed branch.

*What is missing:* A release signal. The narrative's own Dev Investigation Items flagged this as unknown, and it is: there is no source.

*What it would take:* The cheapest literal option is to extend the existing GitHub webhook to accept the `release` event, which arrives with a tag and is unambiguous. That works for GitHub-connected projects and nothing else — GitLab and Azure DevOps integrations exist and would need their own. A platform-neutral alternative is to derive a release from features transitioning to a shipped state, which covers every project but means "release" is inferred rather than observed, and inherits whatever noise the PM tool sync has.

*Once a signal exists,* the refresh side is small: the trigger dispatches the same job the sweep does, and because a refresh advances "last refreshed" rather than a fixed schedule anchor, additivity (FR8) needs care — the shipped slice's cadence is measured from the last refresh, so a release-triggered refresh would in fact delay the next scheduled one unless the anchor is separated from the refresh timestamp. This is a real design consequence of the shipped slice and the thing to check first when picking this up.

---

**D3. AI-driven notification routing by role** — narrative FR23–FR24.

*Asked for:* The right person for a clarification notification is resolved by AI: identify the document type, resolve the owning role (PRD → Product Owner), find project members in that role, use recent context to pick the individual, and fall back to notifying the whole role group.

*What exists:* `ProjectMember.role` — but the enum is `OWNER`, `PROJECT_ADMIN`, `EDITOR`, `COMMENTER`, `VIEWER`. These are permission levels. There is no field for a member's function, discipline, job title, or specialty anywhere on the model.

*What is missing:* The data to route on. The narrative names story #468 (Project Member Role/Function Tagging) as the dependency; that story does not exist in this repository in any form.

*What it would take:* #468 first. Without it there is no "Product Owner" to resolve a PRD to, and the narrative's own accepted fallback — notify the role group — has no role group to notify either. The genuinely available fallback is different from the one the narrative assumed: notify the document's subscribers and the project's editors. That is buildable today and is what D1 should use if it ships before #468.

*Sequencing note:* This is dependent on D1, not the other way around. There is nothing to route until there is a clarification item to route.

---

**D4. Slack and Microsoft Teams as personal notification channels** — narrative FR25–FR27, AC19–AC20.

*Asked for:* Clarification notifications delivered in-app by default, with Slack and/or Microsoft Teams configurable per user as additional channels. The narrative records this as already-built infrastructure to be reused.

*What exists:* Slack and Teams are integrated, and the send primitives are real. But the delivery is channel-posting for newsletters — a project's newsletter posted into a Slack or Teams channel. Per-user notification delivery is a separate system, and it supports exactly two external channels: email and webhook. A search for any Slack or Teams delivery path in the notification system returns nothing.

*What is missing:* Slack and Teams as notification delivery channels. This is net-new work, not reuse. It is also a different shape of thing than what exists: delivering to a *person* means a DM, which needs a mapping from a Fabric user to a Slack or Teams identity. That mapping does not exist either.

*What it would take:* A per-user delivery preference for each platform, an identity mapping from Fabric user to platform user, and a delivery path in the notification dispatch. The OAuth and send primitives are genuine prior art and the integration is not starting from zero — but the claim that this is already done is the single largest misestimate in the narrative.

*Worth confirming with the PM:* whether "notify the relevant team member via Slack" was ever meant as a DM, or whether posting into the project's existing Slack channel would satisfy the intent. The latter is substantially cheaper and reuses what genuinely exists.

---

**D5. Excluding feature-flagged code from refresh context** — narrative FR28, AC18.

*Asked for:* When a refresh ingests codebase context, feature-flagged and therefore user-inaccessible functionality must not be described as live, shipped, or current.

*What exists:* Nothing applicable. Fabric's own feature flags are `process.env.FEATURE_*` reads, resolved per deployment. There is no flag table, no flag registry, no flag service.

*What is missing:* The premise. FR28 is about the *customer's* connected repository, not Fabric's own code — so the question is whether flag-gated code can be identified in an arbitrary third-party codebase. There is no general mechanism for that, and there cannot be a reliable one: a feature flag is a convention, not a language construct, and every codebase expresses it differently.

*What it would take:* Honest options, in ascending order of cost and descending order of magic:
- Let the project declare its flag convention (a config pattern, an SDK, a naming rule) and exclude matches. Bounded, explicit, and only as good as the declaration.
- Integrate with the flag providers customers actually use (LaunchDarkly, Statsig, Unleash) and read the flag state directly. Accurate where it applies, and applies nowhere else.
- Instruct the model to hedge on anything that looks flag-gated. Cheap, unreliable, and quietly wrong in exactly the way FR28 exists to prevent.

*Recommendation:* Do not build this as specified. Reframe it with the PM. The underlying fear — that a document confidently describes a feature users cannot reach — is legitimate and worth addressing, but "detect feature flags in any repository" is not a solvable version of it. A refresh grounded in features and transcripts rather than raw code is a better answer to the same fear.

### Dependencies / Assumptions

- D1 is the only item buildable today without new platform capability. D3 depends on D1 and on story #468. D2 depends on a release signal that must be chosen and built. D4 depends on a user-to-platform identity mapping. D5 depends on a reframing.
- Every "what exists" and "what is missing" statement above was verified against the codebase on 2026-07-13. The three most consequential — no Slack/Teams notification delivery, no functional role tagging, no release event — were checked independently and confirmed.
- The narrative's Key Decisions section records several of these gaps as resolved dependencies with named owners. Those records are the thing to correct first; re-planning against them without correcting them reproduces the error.

### Sources / Research

- `packages/api/lib/notification-delivery.ts` and `NotificationDeliveryPreference` in `packages/database/prisma/schema.prisma` — external delivery is email and webhook, with a comment stating in-app is always on and only opt-in external channels are represented. No Slack or Teams fields.
- `NewsletterChatDelivery` in `packages/database/prisma/schema.prisma` — the Slack/Teams delivery that does exist: a platform, an external team id, and a channel id. Channel posting, not personal delivery.
- `ProjectMember` and `ProjectMemberRole` in `packages/database/prisma/schema.prisma` — permission levels only.
- `packages/api/modules/projects/procedures/code-indexing/github-webhook.ts` — push events only.
- `UserStory.releaseNotes` in `packages/database/prisma/schema.prisma` — the text field the Release Notes surface aggregates.
- `packages/temporal/src/activities/orchestrator/clarification.ts` — the reusable clarification primitive.
- `packages/temporal/src/activities/code-indexing.ts` — feature flags as `process.env.FEATURE_*`.
