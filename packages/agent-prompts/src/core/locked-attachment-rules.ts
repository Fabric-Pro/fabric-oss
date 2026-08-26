/**
 * Locked-attachment non-editability clause (FR-25 — Fizzy #1747, parent #1702).
 *
 * ── What this is ────────────────────────────────────────────────────────────
 * Dedicated attachments (`StoryAttachment`, added in #1702) are stored SEPARATELY
 * from `UserStory.description` so the AI Assistant cannot rewrite them. This
 * clause is the corresponding *prompt-level* guard: an instruction that these
 * assets are read-only reference material the model must never modify, delete,
 * regenerate, invent, or claim to have analysed.
 *
 * "Read-only" means the model cannot CHANGE them. It no longer means the model
 * cannot READ them — see the delivery split below.
 *
 * It is the sibling of `getInBodyAttachmentPreservationClause` — that clause
 * protects content INSIDE the document body (inline `story-media/` images, fenced
 * code); this one governs the dedicated attachment assets that live OUTSIDE the
 * body and carry a `StoryAttachmentDesignation` of `LOCKED` (immutable, the
 * default) or `UNLOCKED` (context-only, discardable).
 *
 * ── Where it is appended (single source of truth) ───────────────────────────
 * Two prompt-composition surfaces append the return value verbatim, mirroring
 * the sibling clause so the two surfaces cannot drift:
 *
 * - `buildSystemPromptAsync` in the `project_document_generator` langgraph agent
 *   (Surface A — CopilotKit streaming: rewrite, "Update using context", custom
 *   prompts, active skill).
 * - `enhanceFeatureWithAI` in `packages/api/.../enhance-feature.ts` (Surface B —
 *   the sync-flow fallback: stage transitions, maturation / Clean Spec refresh).
 *
 * Callers MUST append the return value verbatim (concatenation only — no string
 * substitution, truncation, or reformatting). To locate/maintain this rule,
 * grep for `getLockedAttachmentRulesClause` or the `DEDICATED ATTACHMENTS`
 * scope marker. The label is an UPPERCASE non-`#` scope marker (matching the
 * sibling `getInBodyAttachmentPreservationClause`) rather than a `### heading`
 * on purpose: `###` in this prompt denotes document sections the model should
 * emit, and heading-like tokens risk being echoed into the persisted body.
 *
 * ── The delivery split this clause encodes ──────────────────────────────────
 * This was a true no-op for its first life: nothing about an attachment reached
 * any prompt, so every rule here fired against an empty set. That is no longer
 * the case, and the wording was narrowed to match rather than deleted.
 *
 * - LOCKED (the default): content still never reaches a prompt. The isolation is
 *   structural — the resolver filters on designation before it reads anything.
 * - UNLOCKED (context-only): text-bearing files ARE delivered inline, extracted
 *   and character-budgeted, wrapped in the shared attachment envelope. Built by
 *   `packages/api/modules/projects/lib/story-attachment-ai-context.ts`.
 *
 * So the "you do not receive contents" rule is scoped to LOCKED. Leaving it
 * unqualified would tell the model to disbelieve text it was just handed. The
 * anti-fabrication rule went the other way and got BROADER: it now covers every
 * attachment whose text is absent from context — LOCKED ones, and context-only
 * ones whose type carries no extractable text (images, video, archives), which
 * the model sees named in the UI but never receives.
 *
 * The clause stays phrased conditionally ("when the context lists attachments…")
 * and still tells the model not to invent an attachments section when none are
 * present, so it remains safe to include unconditionally on every surface.
 *
 * NOTE: The originating ticket (#1747, AC-9) framed this rule as gated behind
 * `FABRIC_FEATURE_DEDICATED_ATTACHMENTS = OFF`. That flag no longer exists —
 * #1773 made dedicated attachments always-on and deleted every gate.
 */
export function getLockedAttachmentRulesClause(): string {
	return `DEDICATED ATTACHMENTS — READ-ONLY REFERENCE ASSETS
This work item may have file attachments that are stored SEPARATELY from the
document body — they are never part of the text you write or edit. When the
context you are given lists such attachments (for example by filename and lock
state), follow these rules:

- LOCKED attachments (this is the default state) are read-only, immutable
  reference assets. Never modify, delete, regenerate, rename, or reorder them,
  and never produce output that implies you changed, removed, or added an
  attachment.
- You do NOT receive the contents of a LOCKED attachment. Never claim to have
  opened, read, viewed, seen, or analysed one (such as a screenshot, mockup, or
  PDF), and never describe or invent its contents beyond metadata that is
  literally present in the context (such as a filename).
- UNLOCKED (context-only) attachments may be supplied to you inline, with their
  text already present in your context. Where that text is present, it is input
  you have been given: use it, and do not say you opened or retrieved the file.
- Never invent, describe, or fabricate the contents of any attachment whose text
  is NOT present in your context, whatever its lock state. A filename on its own
  is metadata, not content — an image, video, or archive named in the context was
  not read by you.
- If the context does not mention any attachment, do not add an attachments
  section and do not reference any attachment.`;
}
