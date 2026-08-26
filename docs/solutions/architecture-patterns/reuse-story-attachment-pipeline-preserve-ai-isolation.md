---
title: "Extend the shipped StoryAttachment pipeline into a new surface without breaking its AI-isolation invariant"
date: 2026-07-08
category: architecture-patterns
module: web project stories attachments
problem_type: architecture_pattern
component: full_stack
severity: medium
applies_when:
  - "Adding file-attachment support to a new UI surface (e.g. the Create work-item dialog)"
  - "A first-class attachment system already exists and is deliberately isolated from the AI Assistant"
  - "A spec asks for 'context only' files to reach the AI while 'asset' files stay protected"
tags: [story-attachment, attachments, reuse, ai-isolation, designation, locked-unlocked, deferred-upload, create-dialog, r2, oRPC]
related_components: [stories, ai-assistant]
---

# Extend the shipped StoryAttachment pipeline into a new surface without breaking its AI-isolation invariant

## Context

Fabric already shipped a first-class attachment system (`StoryAttachment`, #1702): a full R2 upload pipeline (presign → PUT → `createAttachment` reserve-then-promote → `listAttachments` signed GET → `removeAttachment` → retention/orphan sweeps), a `LOCKED`/`UNLOCKED` designation, an allowlist that already includes `.docx`/`.md`/`.txt`, and a story-detail UI (`AttachmentsTab`). It is **deliberately isolated from the AI Assistant** — the schema comment says it is stored separately from `UserStory.description` "so the AI Assistant cannot touch it," and a tripwire test (`attachments-ai-isolation.test.ts`) asserts the agent media resolver never sees `story-attachments`.

The task ("attach `.docx`/`.md`/`.txt` when creating a feature") looked like new construction but was ~70% **wiring the existing pipeline into a new surface** (the Create work-item dialog), plus a subset that collides with the isolation invariant.

## Guidance

1. **Reuse the shipped pipeline; do not rebuild.** The Create dialog previously used the old image-only path that appends keys inline into `description`. Text files should go through the existing `uploadStoryAttachment` (first-class rows), not the inline path. The only new server change needed was an **optional `designation` input on `createAttachment`** (default `LOCKED`, backward-compatible) so the create flow can set the label in one call.

2. **Deferred-upload orchestration.** The attachment API needs a saved `userStoryId`, so buffer files client-side and upload **after** the story is created, in a `Promise.allSettled` loop, and only `closeDialog()` after the uploads settle (there is an ordering-contract test for this). Doc attachments never patch the description.

3. **Map the product's "asset vs context only" onto the existing enum** (`asset → LOCKED`, `context only → UNLOCKED`) instead of adding a new field. In v1 this designation gates **deletion only** (LOCKED must be unlocked before removal) — it carries no AI-visibility behavior yet.

4. **Split the AI-injection (FR8) out and keep the #1702 isolation invariant intact.** The spec wanted "context only" content fed to the AI. That directly reverses a deliberate, tested safety boundary a teammate built. The right move was to **defer** AI injection to a follow-up (owned with the invariant's author), ship storage/display/designation now, and keep the tripwire test green. The spec itself allowed this: FR8 used "MAY" and its Dependencies section allowed "context integration deferred."

5. **Verify allowlist claims against live code, not the spec — and scope the answer to the surface you checked.** A stale design doc said `.md` (`text/markdown`) was not allowlisted and would be rejected; the live `packages/utils/lib/attachment.ts` already allowlists it and `resolveAttachmentMime` rescues the empty-MIME `.md` case. No allowlist change was needed — confirmed by reading the constant, not the spec.

   That conclusion held **for the story-attachment surface only**, and read as a product-wide answer it became its own stale claim. Project-context, wizard, and workspace-document uploads went through a *different* resolver that had no extension fallback, so the same `.md` file was still refused there whenever the OS gave the browser no MIME — the defect eventually reported as Fizzy #2139 and fixed by routing those surfaces through the same shared resolver. The lesson generalizes the one above: "I read the constant" answers the question for the vocabulary you read, and this repo deliberately keeps one vocabulary **per surface**. Name the surface in the finding, or the next reader inherits a false all-clear.

## Why This Matters

Treating an "add attachments" ask as greenfield would have duplicated a whole R2 pipeline and, worse, could have quietly reversed the AI-isolation invariant that a teammate built on purpose. Recognizing the reuse (and the one genuinely-new, invariant-touching part) shrank the build, kept it safe, and turned the risky AI-injection piece into an explicit, owned follow-up rather than an accidental regression.

## When to Apply

When a feature request lands in an area where a first-class subsystem already exists, especially one with an explicit safety invariant (isolation, tenancy, immutability). Ground the scope in the shipped code, reuse the pipeline, and if the request collides with the invariant, split that collision into a deferred, owned change instead of quietly reversing the boundary.

## Examples

- **Reuse seam:** wire `uploadStoryAttachment` (rows) into the create dialog; keep the old inline image path unchanged (two attachment controls coexist in v1).
- **One backward-compatible server change:** `createAttachment` input gains `designation: z.enum(["LOCKED","UNLOCKED"]).optional()`, persisted as `input.designation ?? "LOCKED"`.
- **Invariant guard:** the deferred FR8 work must refine — not delete — the isolation rule ("only UNLOCKED/context-only content reaches the AI as read-only; LOCKED/asset never does") and update the tripwire test deliberately, with the #1702 author in the loop.
</content>
