---
title: Type Conversion Regenerates the Work Item Body - Plan
type: feat
date: 2026-08-06
topic: type-conversion-regenerates-spec
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: legacy-requirements
execution: code
---

# Type Conversion Regenerates the Work Item Body - Plan

## Goal Capsule

- **Objective:** converting a work item's type immediately rewrites its body through the new type's template; a mixed-type merge follows the surviving item's type; a hand-picked prompt of the wrong type is refused at creation as well as at edit; those rewrites stop reasoning about section names; and no asset is lost to any of them.
- **Product authority:** Fizzy #2048, reopened. FR9-FR13 and the Type Change Auto-Refresh / Merge Type Resolution / Hand-Picked Prompt Guard / Full-Rewrite Guard Behavior acceptance groups are the new surface. FR1-FR8 shipped in the first pass and are regression surface only.
- **Builds on:** the first pass, already on `master`. The server decides which template a work item's action runs; `projects.stories.resolvePrompt` takes an item id, reads the stored kind, and resolves the kind-scoped binding. Nothing here re-opens that.
- **Open blocker, one:** does "no manual confirmation modal" also retire the type-change confirmation dialog, or only the separate refresh approval? U7 keeps the dialog on the narrower reading. This must be answered before U7 lands — see Stop conditions.
- **Stop conditions:** stop and ask before U7 on the dialog question above. Stop and ask if honouring "no confirmation modal" would mean writing a body the model did not actually produce.
- **Product Contract preservation:** unchanged. This plan adds HOW only. Three implementation choices were put to the requester during planning and are recorded as KTD3, KTD4 and KTD5.

---

## Product Contract

### Summary

The first pass made the server the authority on which template an AI action runs. It deliberately stopped short of four things, each recorded as a scope boundary at the time. The product owner has now decided all four the other way, and this plan implements that reversal: conversion regenerates, mixed merges follow the survivor, the creation surface is guarded, and rewrites stop reasoning about section names.

### Problem Frame

Converting a work item's type changes what the *next* AI action produces, and nothing else. The body, the QA analysis and the maturation digest all continue to present as current, so a converted bug keeps feature-shaped content until somebody notices and re-runs a refresh by hand. That was a deliberate call under F-171 and is stated in four places today — the conversion handler's header comment, its published route description, the confirmation dialog's copy, and the canonical vocabulary. The product owner has decided it is wrong: bug and feature templates differ substantially, and no case was found where an immediate refresh is unwanted.

**This pass regenerates the body only.** The QA analysis blob and the maturation digest stay as they are, and a converted item still carries stale versions of both. That is a deliberate narrowing, recorded under Deferred below, and QA should not read it as a defect in this change.

Three narrower gaps travel with it. A merge between a bug and a feature has no defined winner, so the merged body resolves through a kind-agnostic prompt and comes out feature-shaped. A hand-picked prompt bound to the other type is refused when editing an item but not when creating one. And the guard that protects a bug body from being rewritten into feature shape matches section names by substring, so a feature headed `Business Impact` registers as the bug section `Impact`.

Underneath all four sits one asset question. A body rewrite replaces the column that inline images live in; a merge discards one of two items. Assets must survive both.

### Requirements

Carried from Fizzy #2048. FR1-FR8 shipped in the first pass; the requirements below are this plan's surface.

- **FR9.** Converting an already-created item's type automatically triggers a full spec refresh of its body using the new type's template, with no separate manual trigger and no confirmation modal.
- **FR10.** A merge between items of different types selects the template from the surviving item's type, as designated by the user in the merge flow. Same-type merges are unchanged.
- **FR11.** A hand-picked prompt that does not match the work item's current type is refused at creation time, as it already is at edit time.
- **FR12.** A refresh triggered by a type change or a mixed-type merge must not decide what to carry forward by matching old and new section headings. It rewrites through the new type's template, treating prior content strictly as reference context.
- **FR13.** Attachments and inline images present on the prior content survive any type-change-triggered or mixed-merge-triggered refresh. For a merge, assets from **both** source items survive.
- **NFR1.** Every generation records which template ran, for which kind, from which entry point, and whether resolution hit or missed.

### Acceptance Examples

Named by the ticket's acceptance groups, which restart their numbering per group.

- **AE-TCAR1.** Changing an item's type triggers a full refresh through the new type's template, with no confirmation modal.
- **AE-TCAR2.** A type-change-triggered refresh carries forward the attachments and inline images the prior content had.
- **AE-MTR1.** Merging a bug with a feature uses the template matching the surviving item's type.
- **AE-MTR2.** A same-type merge behaves exactly as before.
- **AE-HPG1.** Hand-picking a prompt that does not match the item's type is refused at creation.
- **AE-FRG1.** A conversion- or mixed-merge-triggered refresh rewrites through the new template rather than matching section names between old and new — and the produced body carries the target type's sections and none of the source type's.
- **AE-FRG2.** Assets from the prior content survive that rewrite.
- **AE-REG1.** An item whose type was never changed resolves the same template as before, and nothing regenerates.

### Scope Boundaries

**In scope.** The four reversals above, their asset consequences, the canon updates they force, and the tenant-isolation checks that become load-bearing once conversion and merge gain tenant-keyed prompt reads.

**Deferred to follow-up work.**

- **The substring section-name matcher keeps its current behaviour on the AI-update and backlog-apply paths.** The ticket's In Scope list reads "replace the substring-based guard"; FR12 states the narrower rule that a *triggered refresh* must not match section names. This plan implements the narrower reading — see KTD2 — so after it ships a feature headed `Business Impact` still registers as the bug section `Impact` on those two paths. Narrowing the matcher itself would change guard behaviour for every existing item on paths this change does not otherwise touch.
- Marking the QA analysis blob and the maturation digest stale on conversion. The first pass deferred these alongside the body; only the body is in scope here.
- The type-conversion control on the AI update approval stage. The ticket's own Out of Scope section places it in a separately tracked initiative.
- Migrating the backlog analyzer's proposal bodies into the prompt catalog. Deferred by the first pass and still deferred.

**Not a goal.** Changing same-type merge behaviour. Fixing the classifier's type bias. Removing the legacy third type — already retired, its rows migrated.

---

## Planning Contract

### Key Technical Decisions

**KTD1 — regenerate through `draftBodyByKind`, not through the guarded re-analysis path.**

`packages/temporal/src/lib/reanalyze-body-by-kind.ts` exists to *preserve* an existing structure and make targeted edits. A conversion needs the opposite.

`draftBodyByKind` (`packages/temporal/src/lib/create-story-from-proposal.ts`) is the right primitive: a plain exported function, already public on `@repo/temporal` and already imported by `@repo/api`, parameterised *by* kind rather than inferring it, returning `needsMoreInfo`, and never throwing on model failure. `packages/api/modules/projects/procedures/stories/reformat-proposal-body.ts` already calls it from a procedure under the same permission gate.

It is not a drop-in. It has no media reinjection, no back-link placement, no output validation, and logs only its unbound case. U5 adds all four, because it will now write to the database rather than return a candidate.

**KTD2 — the section-signature guard stays off this path; its content-loss checks do not.**

`detectDestructiveRewrite` has three production call sites across two files: two in `reanalyze-body-by-kind.ts` (the AI-update path) and one in `analyze-context.ts` (the backlog-apply path, a deliberate belt-and-braces net before a write).

Its rules split into two groups. The **section-signature** rules — `bug_sections_dropped`, `feature_sections_dropped`, `cross_type_reformat` — decide what to carry forward by matching heading names. Those are exactly what FR12 forbids on a triggered refresh, and running them on a conversion would refuse legitimate rewrites by construction. They stay off this path.

The **kind-agnostic** rules — `empty_output` and `body_collapsed` — do not reason about section names at all. FR12 never asked to remove them, and they are the only thing standing between a model that technically succeeded and a body replaced by a three-line stub. `draftBodyByKind` reports `aiDrafted: true` for any non-null response, so KTD5's refuse-on-failure catches an unbound prompt or a thrown call and nothing else. U5 splits the kind-agnostic rules into their own predicate in `structure-guards.ts` and runs it before the write.

**The prohibition is on the section-signature rules only, and it must be recorded where an editor will hit it** — a comment at U5's write site naming the ticket and stating why re-adding them would stop conversions regenerating, plus a line in the canonical vocabulary. A drift test alone is not enough: a test that asserts one named function is not called passes if someone re-implements the same matching inline.

**KTD3 — regeneration runs asynchronously, workflow-backed, deduplicated per item.** *(Decided by the requester during planning.)*

The redraft is a model call on the order of a minute. Blocking the conversion request on it would hang the UI and risk request timeouts. `packages/api/modules/projects/procedures/backlog/start-proposal-draft.ts` sets the precedent: an API procedure starts a Temporal workflow on the `ai-chat` task queue, the workflow proxies a heartbeating activity, and the activity writes under a compare-and-set.

That precedent is race-safe because it *atomically claims a slot* before starting. Conversion must do the same, or a user alternating an item's type starts an unbounded series of minute-long model calls on a queue shared with interactive AI paths. The workflow takes a deterministic per-item id so only one regeneration is ever in flight for a given item.

**KTD4 — the merge carries assets from both items, using the storage provider's own copy.** *(Decided by the requester during planning.)*

Today `reconcile-merged-attachments.ts` strips every media reference from the merged body and re-appends only the survivor's keys. The duplicate's inline images are dropped, and its uploaded attachment rows stay bound to the retired item.

Making the duplicate's assets survive is not a key rewrite. Media URL resolution rejects any key outside `story-media/{projectId}/{storyId}/`, and attachment download rejects any key outside `story-attachments/{projectId}/{storyId}/`, so a re-pointed key resolves to nothing. The duplicate's objects are **copied** into the survivor's keyspace under new keys. `@repo/storage` already exposes a within-bucket server-side copy, and both keyspaces live in the same bucket, so no new capability is needed.

**Source keys are validated before anything is copied.** Media keys are harvested by scanning free-text markdown, which any user can write. Every harvested key must match the duplicate's own prefix before it is copied, mirroring the survivor-prefix filter the current code relies on — otherwise a pasted key from another project would have the server copy a stranger's object into the caller's keyspace.

A copy failure does not fail the merge. The merge completes, the uncopied assets are logged with their keys, and the merged body references only what exists.

**KTD5 — the safety net for an unreviewed rewrite is a version snapshot, a content floor, and a refusal to write on failure.** *(Decided by the requester during planning.)*

The product owner's "no confirmation modal" removes the diff review that this repository treats as the safety property of an interactive AI engine. That concern is real and is not being waved away; it is met with three mechanisms instead of a modal.

The prior body is snapshotted as a `FeatureVersion` before the rewrite, so the pre-conversion content is recoverable. The kind-agnostic content floor from KTD2 refuses a write that empties or collapses the body. And a redraft that reports the model did not run leaves the body exactly as it was and records the miss.

Version history is the whole net, so it has to read correctly once an AI joins the writer set: the snapshot carries the prior body's own author, not the actor who triggered the conversion, and the regenerated body is attributed to the AI rather than to that actor.

**KTD6 — the create-time guard moves into `@repo/temporal` as a pure decision with a typed error.**

At the moment `create-story.ts` holds a hand-picked prompt id, the work item does not exist and its type is not knowable: the `kind` input is documented as a hint, the shipped UI does not send it, and the classifier is licensed to overrule it. Guarding against that hint would pass a feature-bound prompt for an item the classifier then routes to bug.

The only point where a trustworthy kind and the explicit prompt coexist is inside `create-story-from-proposal.ts`, between classification and prompt resolution — in `@repo/temporal`, which cannot import the api-side guard.

The guard already splits into a pure decision and an async wrapper. The decision and its binding lookup move to `@repo/temporal` and throw a typed error; `packages/api` catches it by `instanceof` and maps it to a refusal, mirroring `ContextUpdateTruncatedError` and `AIProviderNotConfiguredError`. No orpc dependency is added to the workflow package.

**KTD7 — regeneration state is persisted, not inferred.**

An asynchronous rewrite the user cannot observe is worse than a synchronous one. The repo already has `BackgroundJob` — a row carrying a workflow id, a status and steps, swept by a watchdog that fails stale rows. The conversion opens one when it starts the workflow and the activity closes it. Everything the front end shows — in flight, done, failed — reads from that row, so it also survives a page reload and a navigation away.

**KTD8 — the canon is narrowed, not deleted.**

`CONCEPTS.md` currently states that converting an item's kind leaves its body alone *and* that nothing already generated is marked stale. The first half is reversed; **the second half stays true** and must survive the rewrite, because the QA analysis blob and the maturation digest are explicitly deferred. The entry keeps what still holds — the stored row is the only authority on kind, a caller-supplied kind is a claim rather than a fact, and nothing already generated is marked stale — and replaces only the regeneration clause. The handler's header comment, its published route description, and the dialog copy assert the same retired rule and are updated in the same change.

### Key Risks

- **A converted item is left mid-rewrite.** The workflow can fail after the flip lands. The flip and the regeneration are separate steps by design; a failed regeneration leaves a valid item with its prior body, the job row records the failure, and the user is told.
- **The creation guard changes a failure contract for seven callers.** `createStoryFromProposal` gains a throwing mode. Six of the seven supply no prompt id, so their contract is unchanged in practice — U2 records that enumeration rather than assuming it.
- **A copy failure could orphan or drop an asset.** Copy before write, never reference an object whose copy did not succeed, log every skipped key.
- **The dialog question is unresolved.** If the product owner intends the type-change dialog to go too, U7's copy work is discarded. It is a stop condition, not an assumption — the previous draft of this plan justified keeping the dialog partly because an E2E spec depends on it, which is a test-convenience argument for a product decision and does not hold: that spec is fast because it is AI-free, which survives either answer.

### Assumptions

- `BackgroundJob` accepts a new kind value without schema changes beyond the enum. If it does not, U6 grows a migration.

---

## Implementation Units

### U1. Relocate the prompt/kind decision into the workflow package

**Goal:** the kind guard becomes callable from `@repo/temporal` without inverting the package dependency, and without adding an orpc dependency there.

**Requirements:** FR11 (enabling). **Dependencies:** none.

**Files:**
- Create `packages/temporal/src/lib/prompt-kind-guard.ts` — the pure decision plus the binding lookup, throwing a typed `PromptKindMismatchError`.
- Modify `packages/temporal/index.ts`, `packages/temporal/package.json` — export it, following the subpath precedent set by the kind-to-agent mapping.
- Modify `packages/api/modules/projects/lib/validate-prompt-for-kind.ts` — keeps **both** current exports as wrappers.
- Test `packages/temporal/__tests__/prompt-kind-guard.test.ts`.
- Test `packages/api/modules/projects/lib/__tests__/validate-prompt-for-kind.test.ts` — existing file, must keep passing unchanged.

**Approach:** move the binding query and the deny-by-default decision verbatim. The api module keeps a synchronous `assertPromptKindCompatible` *and* the async `validatePromptForKind`, each catching the typed error and re-throwing the existing refusal with a byte-identical message — the existing test file calls the synchronous export directly and asserts the refusal's error code, so a single async wrapper would turn that suite red.

**Patterns to follow:** `packages/temporal/src/lib/clean-spec-agent-for-kind.ts` for where a shared helper lives and why. `packages/temporal/src/lib/update-with-context-core.ts` for a typed error thrown from temporal and mapped in api.

**Test scenarios:**
- A prompt bound to the item's kind passes.
- A prompt bound to the other kind throws, naming both the bound kind and the item's kind.
- A prompt with no bindings at all throws — absence is refusal, not permission.
- A prompt with a null kind scope passes for both kinds.
- Both api wrappers convert the typed error into the same refusal, with a byte-identical message and the same error code.

**Verification:** the existing guard test file passes without edits.

### U2. Enforce the guard at creation

**Goal:** a hand-picked prompt that contradicts the item's classified type is refused before it is used to draft.

**Requirements:** FR11. **Acceptance:** AE-HPG1. **Dependencies:** U1.

**Files:**
- Modify `packages/temporal/src/lib/create-story-from-proposal.ts` — call the guard after the classifier resolves the effective kind, before prompt resolution consumes the explicit ids.
- Modify `packages/api/modules/projects/procedures/stories/create-story.ts` — map the typed error to a refusal.
- Test `packages/api/modules/projects/procedures/stories/__tests__/create-story-prompt-kind.test.ts`.

**Approach:** the guard runs against the classifier's `effectiveKind`, never against the caller's hint. Both explicit inputs are covered: prompt resolution checks the version id first and returns before the prompt id is read, so the version must be resolved to its parent prompt before comparing.

`createStoryFromProposal` has **seven** call sites. Only `create-story.ts` forwards a prompt id or version id; the other six pass none, so their failure contract is unchanged in practice. Record that enumeration in the unit rather than asserting it.

Pick the document-type axis deliberately and pin it: the edit surface picks a target stage or the clean-spec type, while creation tries the clean-spec type and falls back to the stage, which is itself rewritten for bugs. Because absence of a binding is refusal, asking about the wrong axis turns a prompt the picker legitimately offered into a refused creation.

**Patterns to follow:** `packages/api/modules/projects/procedures/stories/enhance-feature.ts` for guard placement — after the tenant checks, before anything is written.

**Test scenarios:**
- A feature-bound prompt with a body the classifier routes to bug is refused, and no work item is created.
- A prompt matching the classified kind is accepted and drafts normally.
- A hand-picked prompt *version* whose parent prompt is bound to the other kind is refused — the version path does not bypass the guard.
- A prompt bound at the document type the creation picker queried, but not at the other one, is accepted rather than refused — pinning the chosen axis.
- A creation with neither a prompt id nor a version id is unaffected.
- A prompt with a null kind scope is accepted for either classification.
- Covers AE-HPG1.

**Verification:** creation with a mismatched prompt returns a refusal naming both kinds; no row is written.

### U3. Mixed-type merge follows the surviving item

**Goal:** when the two merged items differ in type, the template comes from the one the user chose to keep — and the user can see which type that is.

**Requirements:** FR10, FR12. **Acceptance:** AE-MTR1, AE-MTR2, AE-FRG1. **Dependencies:** none.

**Files:**
- Modify `packages/api/modules/projects/procedures/stories/propose-duplicate-merge.ts` — derive the merge kind from the survivor unconditionally; add the missing organization-membership check; update the comment block documenting the retired policy; keep the mixed-kind field in the resolution log.
- Modify `packages/database/prisma/seed-prompts-only.ts` — add BUG- and FEATURE-scoped merge prompt records.
- Modify `apps/web/modules/saas/projects/components/stories/DuplicateResolveDialog.tsx` — show each item's type on its panel, and say which type's template the merged body will use.
- Modify `packages/api/modules/projects/procedures/stories/__tests__/propose-duplicate-merge.test.ts` — the test asserting that a mixed pair asks for no kind-scoped prompt encodes the retired decision and is rewritten.

**Approach:** a one-line change to the derivation. The existing two-tier resolution already tries the kind-scoped binding and falls back to the kind-null one.

Two things make that one line insufficient on its own. **Only kind-null merge bindings are seeded today**, so without new records both survivor orientations resolve the same prompt and the change is a no-op in every default deployment — the seed is part of this unit, and per the insert-only contract these must be new keys, never edits to existing records. And **this procedure resolves a caller-supplied organization id with no membership check** while reading tenant-scoped prompt bindings; this unit widens that read from kind-null to kind-scoped, so the check is added here with the same shape the sibling resolve procedures use.

The survivor is a genuine user choice — an explicit id from a per-panel button — so the *row it names* is trustworthy; the kind is then read from that stored row, not from the caller.

The merge path does not call the section-name matcher today and must not gain it, for the same reason as the conversion path.

**Execution note:** the rewritten test is a deliberate contract change, not a stale assertion. It carries an in-file comment naming the ticket, the superseded decision and the fact that the product owner reversed it — matching the marker convention already used elsewhere in this codebase — as well as the reasoning in the commit message.

**Test scenarios:**
- A bug survivor merged with a feature duplicate resolves the bug-scoped prompt.
- A feature survivor merged with a bug duplicate resolves the feature-scoped prompt.
- Both orientations of the same pair resolve differently — proving the survivor drives it, not the pair.
- A same-type merge resolves exactly as before.
- With no kind-scoped binding present, a mixed merge falls back to the kind-null prompt rather than failing.
- A caller passing an organization id they are not a member of is refused before any prompt binding is read.
- The merge path does not call the section-signature matcher.
- The resolution log records the survivor's kind and that the pair was mixed.
- Covers AE-MTR1, AE-MTR2, AE-FRG1.

**Verification:** with the seed applied, flipping which panel is the survivor flips the resolved prompt key.

### U4. Carry both items' assets across a merge

**Goal:** inline images and uploaded attachments from the duplicate survive the merge alongside the survivor's own.

**Requirements:** FR13. **Acceptance:** AE-FRG2. **Dependencies:** none — U3 and U4 touch disjoint files and may land in either order.

**Files:**
- Create `packages/api/modules/projects/lib/copy-story-assets-to-story.ts` — the storage copy, covering both the `story-media/` and `story-attachments/` keyspaces, returning which keys copied and which did not.
- Modify `packages/api/modules/projects/procedures/stories/merge-duplicate.ts` — the orchestration point: loads the duplicate's prior body, runs the copy, passes the remapped keys onward.
- Modify `packages/api/modules/projects/lib/reconcile-merged-attachments.ts` — re-append both items' media keys.
- Modify `packages/database/prisma/queries/projects/duplicate-links.ts` — re-parent the duplicate's attachment rows inside the existing merge transaction, alongside the task re-parenting already there, writing their new storage keys.
- Test `packages/api/modules/projects/lib/__tests__/copy-story-assets-to-story.test.ts`.
- Test `packages/api/modules/projects/lib/__tests__/reconcile-merged-attachments.test.ts` — existing file, extended.

**Approach:** `reconcileMergedDescriptionAttachments` is pure and never sees the duplicate, so `merge-duplicate.ts` is where the work is sequenced: it is the only code that already loads a prior row.

**The attachment key question is settled, not deferred.** Attachment download mints a signed URL only for keys under `story-attachments/{projectId}/{userStoryId}/`, and `storageKey` is unique — so a re-parented row keeping the duplicate's key renders as a dead entry. Each object is copied to a new key under the survivor and the row is updated to match.

Every key harvested from the duplicate's body is filtered to the duplicate's own prefix before being copied. Keys are scraped from user-writable markdown; without that filter a pasted foreign key would have the server copy another project's object into the caller's keyspace.

**Inline-image carry-over applies to the AI-combined merge path only** — a plain merge writes no new survivor body, so there is nowhere for the duplicate's image markdown to land. On that path the duplicate's assets survive through the re-parented attachment rows alone.

A copy failure does not fail the merge.

**Patterns to follow:** the existing strip-then-re-append shape in `reconcile-merged-attachments.ts`; the task re-parenting already inside the merge transaction; `@repo/storage`'s within-bucket copy.

**Test scenarios:**
- A combined merge where only the survivor has inline images keeps them all.
- A combined merge where only the duplicate has inline images copies them and references the new keys.
- A combined merge where both have images keeps both sets, with no key collision.
- A duplicate whose body references a key outside its own prefix copies nothing and leaves no reference in the merged body.
- A copy failure on one asset completes the merge, logs the failed key, and leaves no reference to it.
- The duplicate's uploaded attachment rows are attached to the survivor with keys under the survivor's prefix, and download resolves.
- A plain merge with no combined body still moves the duplicate's attachment rows.
- A merge with no assets on either side behaves as before.
- Covers AE-FRG2.

**Verification:** after a mixed merge with assets on both sides, every image in the merged body resolves and every attachment downloads.

### U5. The regeneration activity and workflow

**Goal:** a durable, restartable job that rewrites a converted item's body through the new type's template and persists it safely.

**Requirements:** FR9, FR12, FR13, NFR1. **Acceptance:** AE-TCAR1, AE-TCAR2, AE-FRG1, AE-FRG2. **Dependencies:** none. U6 depends on this.

**Files:**
- Create `packages/temporal/src/activities/stories/regenerate-body-for-kind.ts` — the activity.
- Create `packages/temporal/src/workflows/regenerate-body-for-kind-workflow.ts` — the workflow proxy.
- Modify `packages/temporal/src/activities/index.ts`, `packages/temporal/src/workflows/index.ts` — register both.
- Modify `packages/temporal/src/lib/structure-guards.ts` — split the kind-agnostic content checks into their own predicate, leaving `detectDestructiveRewrite`'s behaviour unchanged for its existing callers.
- Modify `packages/temporal/src/lib/create-story-from-proposal.ts` — add the canonical resolution log to `draftBodyByKind`'s success path, which today discards the resolved key and source.
- Test `packages/temporal/__tests__/regenerate-body-for-kind.test.ts`.
- Test `packages/temporal/__tests__/structure-guards.test.ts` — existing file, extended for the new predicate.

**Approach:** the activity redrafts through `draftBodyByKind` using the item's *current stored* kind, and the workflow forwards both `organizationId` and `userId` to it — omitting either silently resolves prompts and model settings in personal context.

Before writing, in order: snapshot the prior body as a `FeatureVersion` attributed to its own author; refuse when the redraft reports the model did not run; refuse when the new body trips the kind-agnostic content floor; reinject any media keys the model dropped; re-place the back-link.

**The write is not description-only.** `draftBodyByKind` falls back to the input acceptance criteria when the bug branch returns none, so a feature converted to a bug would otherwise keep its acceptance-criteria checklist — the exact cross-type bleed the ticket forbids. The write clears `acceptanceCriteria` for a BUG target, sets it from the redraft for a FEATURE target, and persists `needsMoreInfo` from the redraft.

**The stale-write guard is the row's monotonic version, not its kind.** Kind has two values, so a double toggle returns it to the value an in-flight workflow read and its check would pass. `updateStory` already exposes an `expectedVersion` guard; the activity captures the version at start and writes under it, which also discards a redraft that lost a race to a concurrent human edit.

The activity heartbeats across the model call and closes its job row on both outcomes.

**Execution note:** the prohibition from KTD2 is load-bearing and goes in the code, not only in this plan. The write site carries a comment naming the ticket and stating that the section-signature rules must never be added here, and why re-adding them would stop conversions regenerating.

**Patterns to follow:** `packages/temporal/src/activities/backlog-context/draft-proposal-body.ts` for a heartbeating activity that writes under a compare-and-set. `packages/api/modules/projects/procedures/stories/enhance-feature.ts` for the snapshot, reinjection and back-link steps that follow a model call before a persisted write.

**Test scenarios:**
- A bug body regenerated as a feature is written through the feature template.
- A feature body regenerated as a bug is written through the bug template.
- The persisted body carries the target kind's signature sections and none of the source kind's.
- A feature with acceptance criteria converted to a bug persists none.
- A bug redraft persists the returned `needsMoreInfo`.
- A failed model call writes nothing and leaves the prior body intact.
- A model response that collapses the body below the content floor writes nothing and records the reason.
- A prior body containing inline images keeps them when the model returns them, and when the model drops them.
- A double toggle back to the original kind discards the first workflow's stale write.
- The activity and `draftBodyByKind` both receive the organization and user unchanged.
- The version snapshot is attributed to the prior body's author, and the regenerated body to the AI.
- The section-signature matcher is not called on this path.
- The resolution log records key, kind, entry point and outcome; it never records prompt content.
- Covers AE-TCAR1, AE-TCAR2, AE-FRG1, AE-FRG2.

**Verification:** converting an item produces a body matching the new type's sections, with the prior body retrievable from version history.

### U6. Conversion starts the regeneration, and closes its tenant holes

**Goal:** the conversion procedure triggers the refresh, exposes its state, and stops trusting a caller-supplied organization id.

**Requirements:** FR9, NFR1. **Acceptance:** AE-TCAR1, AE-REG1. **Dependencies:** U5.

**Files:**
- Modify `packages/api/modules/projects/procedures/stories/convert-kind.ts` — membership check; workflow start with a deterministic per-item id on the `ai-chat` queue; open the job row; rewrite both the header comment and the published route description.
- Modify `packages/database/prisma/schema.prisma` plus its migration — the new background-job kind.
- Create `packages/api/modules/projects/procedures/stories/get-regeneration-status.ts` — the read the front end polls.
- Modify `packages/api/modules/projects/router.ts` — register it.
- Modify `packages/api/modules/projects/procedures/stories/__tests__/convert-kind.test.ts` — the test pinning "conversion re-chains no prompt" encodes the retired decision and is rewritten.

**Approach:** two distinct tenant questions must both be answered, and membership answers only the first. Membership confirms the caller belongs to the organization they named. It does **not** confirm that organization owns the project — a user in two organizations could name the wrong one and have the redraft run one tenant's bindings and model settings over the other's content. **The workflow's tenant key is derived from the project row**, and a caller-supplied id that disagrees with it is refused.

The workflow id is deterministic per item so a second conversion supersedes rather than races. The entry point travels in the workflow arguments so the resolution log can record it — NFR1's "from which entry point" has no other source.

The no-op branch stays: converting to the type an item already has writes nothing, starts nothing, opens no job.

**Execution note:** the rewritten test is a deliberate contract change. Its current assertion is an exact key-set match on the update payload and fails on any added field, so the rewrite must be intentional, carry an in-file comment naming the ticket and the superseded decision, and be explained in the commit message.

**Test scenarios:**
- Converting a feature to a bug starts the regeneration with the target kind and opens a job row.
- Converting to the same type writes nothing, starts nothing, opens no job.
- A caller passing an organization id they are not a member of is refused before anything is read.
- A caller naming an organization that does not own the project is refused.
- The workflow argument carries the project's organization, the user, and the entry point.
- A second conversion while one is in flight does not start a second workflow.
- A missing item returns not-found and starts nothing.
- The stage still snaps so the item does not land in a stage invalid for its new type.
- Covers AE-TCAR1, AE-REG1. AE-REG1's "resolves the same template as before" clause is pinned by the first pass's existing resolver tests; name the file in the unit rather than duplicating them.

**Verification:** conversion returns promptly; the job row reaches a terminal state independently.

### U7. Front end: honest copy, visible progress, correct invalidation

**Goal:** the user is told what will actually happen, sees the refresh running, and gets the new body without a manual reload.

**Requirements:** FR9. **Acceptance:** AE-TCAR1. **Dependencies:** U6.

**Blocked on:** the dialog question in the Goal Capsule. Confirm before starting.

**Files:**
- Modify `apps/web/modules/saas/projects/components/stories/ConvertKindConfirmDialog.tsx`.
- Modify `apps/web/modules/saas/projects/components/stories/StoryWorkspace.tsx`, `StoryCard.tsx`, `StoryActionsMenu.tsx` — the three conversion entry points.
- Create `apps/web/__tests__/modules/saas/projects/components/stories/convert-kind-refresh.test.tsx`.
- Modify `apps/web/tests/stories/unique-sequential-ticket-ids.spec.ts` — confirm the flow is still AI-free and adjust if it now waits on anything.

**Approach:** the dialog copy must name the consequence, not gesture at it: the description and acceptance criteria are **replaced** through the new type's template, the current content is used as reference rather than kept, and the previous version is recoverable from history. "The content will be regenerated" reads as additive and is not enough.

Each entry point shows the in-flight state where that surface can: the detail view over the body region, the card and kebab as a badge on the card. All three replace the immediate success toast — it currently asserts a completed conversion and would now claim a rewrite that has not started.

The body editors are read-only from confirmation until the job reaches a terminal state, so a user cannot make an edit the redraft will overwrite. Every invalidation key is derived from the client rather than hand-built; this repository has three query-key shapes and a hand-authored filter silently matches nothing.

Accessibility: the in-flight indicator wraps any animation in `motion-safe:` and lives in a polite live region announcing start, completion and failure; completion moves focus to the regenerated body's heading rather than leaving it on a control that has re-rendered.

**Test scenarios:**
- The dialog states that the description and acceptance criteria will be replaced, and that the previous version is recoverable.
- Confirming shows the refresh in progress at the entry point used.
- The success toast no longer claims the content is updated.
- Completion replaces the body without a manual reload.
- A failed refresh surfaces that the content was not changed.
- The body editors are not editable while the refresh is in flight.
- Returning to the item mid-refresh still shows the in-flight state.
- Completion is announced in the live region.
- Covers AE-TCAR1.

**Verification:** converting from any of the three surfaces shows progress, and settles on either the new body or an explicit failure.

### U8. Update the canon and ship the changeset

**Goal:** every artifact asserting the retired rule is corrected, and the release carries a headline.

**Requirements:** all. **Dependencies:** U1-U7.

**Files:**
- Modify `CONCEPTS.md` — the work item kind entry.
- Create `.changeset/type-conversion-regenerates-spec.md`.
- Modify `docs/plans/2026-08-03-001-fix-prompt-template-kind-routing-plan.md` — note that its R11 is superseded, without rewriting its history.

**Approach:** narrow the canon rather than delete it. What still holds — the stored row is the only authority on kind, a caller-supplied kind is a claim rather than a fact, and nothing already generated is marked stale — stays; only the clause about the body not being regenerated is replaced, and the replacement says what supersedes it. Add the KTD2 prohibition as a line in the same entry, so the drift test has a documented rationale to point at.

**Test expectation:** none — documentation and release metadata.

**Verification:** no artifact in the tree still asserts that conversion leaves the body alone.

---

## Verification Contract

| Gate | Command | Applies to |
|---|---|---|
| Types | `pnpm type-check` | all units |
| Lint and format | `pnpm lint` | all units |
| API tests | `pnpm --filter @repo/api test` | U1, U2, U3, U4, U6 |
| Temporal tests | `pnpm --filter @repo/temporal test` | U1, U2, U5 |
| Database tests | `pnpm --filter @repo/database test` | U3, U4 |
| Web tests | `pnpm --filter web test modules/saas/projects/components/stories` | U3, U7 |
| E2E | `pnpm --filter web e2e tests/stories/unique-sequential-ticket-ids.spec.ts` | U7 |
| Worker reload | restart the temporal worker through the Aspire tooling | U1, U2, U5 |
| Manual check | convert an item with inline images in both directions; confirm the body matches the new type, no acceptance criteria survive onto a bug, the images survive, and the prior body is in version history | U5, U6, U7 |
| Manual check | merge a bug with a feature in both orientations, with assets on both sides, on the combined and plain paths | U3, U4 |
| Manual check | create a ticket from a proposal on the toggled, counter-toggled and untoggled paths; confirm the template matches the classified type and the no-prompt path is never refused | U2 |

Run `pnpm --filter @repo/database generate` before trusting a type error in `@repo/api` — a stale generated client produces a large phantom count.

---

## Definition of Done

- Every acceptance example maps to at least one passing test.
- No template decision on any covered path is made from a caller-supplied kind; every kind is read from a stored row, including the merge template, which follows the survivor row's stored kind selected by a caller-supplied id.
- The section-signature matcher is not called on the conversion or mixed-merge paths, and a test says so for each; the kind-agnostic content floor **is** applied before the conversion write.
- The two tests that pinned the retired decisions are rewritten deliberately, each carrying its reasoning in the test file as well as the commit message.
- Conversion refuses a caller-supplied organization id without membership, and refuses one that does not own the project; the merge proposal refuses a non-member.
- A failed or collapsed regeneration leaves the prior body intact and records the miss where the user can see it.
- A feature converted to a bug carries no acceptance criteria.
- No artifact still asserts that conversion leaves the body alone.
- A changeset bumping only `fabric-app` as a patch, one sentence on line 1, context below a blank line.
- No real person, organization, host or internal URL anywhere in the diff; the ticket is cited by number.
