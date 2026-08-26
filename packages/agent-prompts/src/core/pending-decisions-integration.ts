/**
 * Resolved-decisions integration clause (Feature Maturation V2, notebook model).
 *
 * Single source of truth for the system-prompt augmentation that tells the model
 * how to treat the transient `## Resolved Decisions (pending integration)`
 * appendix that `recordAnswerInSpec` writes (deterministically, no model call)
 * when the product owner answers an open question.
 *
 * Two prompt-composition surfaces append the return value verbatim — the same
 * "cannot drift" contract as `getInBodyAttachmentPreservationClause`:
 *
 * - `buildSystemPromptAsync` in the `project_document_generator` langgraph agent
 *   (CopilotKit streaming path — stage transitions, "Update using context").
 * - `enhanceFeatureWithAI` in `packages/api/.../enhance-feature.ts` (the
 *   sync-flow fallback that fires when the frontend cannot resolve a prompt).
 *
 * Before this clause was shared, it lived only on the API surface, so agent-path
 * runs silently ignored answered decisions: they neither integrated nor pruned
 * the appendix and re-asked questions the PO had already settled. Centralising it
 * here guarantees both surfaces read identical instructions. Callers MUST append
 * the return value verbatim (concatenation only — no substitution/truncation).
 */

/** The heading of the transient appendix. Shared so the writer (which appends
 * under it) and this clause (which references and deletes it) cannot diverge. */
export const PENDING_DECISIONS_HEADING =
	"## Resolved Decisions (pending integration)";

export function getPendingDecisionsIntegrationClause(): string {
	return `\nRESOLVED DECISIONS: If the current description contains a "${PENDING_DECISIONS_HEADING}" section, treat each bullet as a settled decision the product owner just made. These are AUTHORITATIVE product-owner decisions: they MUST be reflected in your output EVEN WHEN you rebuild the document from scratch or treat prior-stage content as inputs only — never drop one just because you are restructuring. Integrate every one of them into the appropriate part of the spec — a positive requirement becomes a Must Have / Use Case / body statement; a non-goal or limitation becomes an explicit statement under an "## Out of Scope / Constraints" section (create it if absent). Do NOT re-ask, re-open, or re-list as an open question anything these resolved decisions already settle. Then DELETE the "${PENDING_DECISIONS_HEADING}" section entirely from your output. Never echo that heading back.`;
}
