import { z } from "zod";

/**
 * Wire shape of one backlog change as sent by the review UI to
 * `projects.backlog.applyChanges` and the pending-proposal approve
 * procedures. Mirrors `ChangeProposalSchema.changes[]` in
 * `packages/temporal/src/activities/backlog-context/analyze-context.ts`
 * minus the LLM-tolerant preprocessing (the UI normalises before sending).
 *
 * Scope-intake fields (plan §Slice 1) are optional so Teams/meeting
 * proposals keep validating unchanged.
 */
const diffFieldSchema = z.object({
	from: z.string().nullable().optional(),
	to: z.string(),
});

const changeSourceContextSchema = z.enum([
	"teams_messages",
	"meeting_transcript",
	"notion_page",
	"slack_messages",
	"scope_document",
	"user_request",
	"multiple",
]);

export const changeItemSchema = z.object({
	type: z.enum(["epic", "feature", "story", "bug"]),
	action: z.enum(["create", "update"]),
	existingId: z.string().nullable().optional(),
	existingIdentifier: z.string().nullable().optional(),
	existingExternalId: z.string().nullable().optional(),
	title: diffFieldSchema,
	description: diffFieldSchema.nullable().optional(),
	acceptanceCriteria: diffFieldSchema.nullable().optional(),
	priority: diffFieldSchema.nullable().optional(),
	size: diffFieldSchema.nullable().optional(),
	parentEpicIdentifier: z.string().nullable().optional(),
	parentFeatureIdentifier: z.string().nullable().optional(),
	parentEpicTitle: z.string().nullable().optional(),
	parentFeatureTitle: z.string().nullable().optional(),
	// Annotation, not payload — see the note on the generation schema in
	// `analyze-context.ts`. The analyzer is allowed to return a change without
	// either field, so demanding them here would only move the failure to the
	// Apply click, after the reviewer has already spent the effort. The enum
	// still holds for a sourceContext that IS present.
	reasoning: z.string().nullable().optional(),
	sourceContext: changeSourceContextSchema.nullable().optional(),
	/**
	 * Inline PM override of the AI classifier's kind decision. Honored by
	 * `applyBacklogChanges` for create rows — passes `kind` +
	 * `skipClassifier: true` to createStoryFromProposal so the user's
	 * selection wins.
	 */
	kindOverride: z.enum(["BUG", "FEATURE"]).nullable().optional(),
	/**
	 * Safe-hold flag stamped by the structure-preserving update pass when AI
	 * could not safely produce a targeted edit and the existing body was kept
	 * unchanged. Passed through so the apply audit records the safe-hold.
	 */
	bodyMergeFallback: z.boolean().optional(),
	/**
	 * Set when the analysis-time pass already structure-preserved this
	 * update's body. Passed through so `applyBacklogChanges` skips
	 * re-merging (no double LLM call).
	 */
	structurePreserved: z.boolean().optional(),
	/**
	 * Set when a CREATE's body was drafted through the kind prompt at review
	 * time (lazy draft on open). Apply persists it verbatim (no re-draft,
	 * bugs included), carrying `needsMoreInfo`.
	 */
	predrafted: z.boolean().nullable().optional(),
	/** Bug triage flag captured by the review-time draft. */
	needsMoreInfo: z.boolean().nullable().optional(),
	// Scope-intake provenance
	sourceRef: z.string().nullable().optional(),
	labels: z.array(z.string()).nullable().optional(),
	sourceDependencyRaw: z.string().nullable().optional(),
	dependsOnRefs: z.array(z.string()).nullable().optional(),
	dependsOnPhases: z.array(z.string()).nullable().optional(),
	sourceChangeKey: z.string().nullable().optional(),
	deliveryTrack: z
		.enum(["SPIKE", "DISCOVERY", "SPECIFY", "DEFER"])
		.nullable()
		.optional(),
});

export type ChangeItem = z.infer<typeof changeItemSchema>;

/**
 * Locate `change` in the proposal's stored `changes[]`. Prefers the stable
 * `sourceChangeKey` (scope imports), then `sourceRef`, then the legacy
 * (action, type, title, parents) tuple used by Teams proposals.
 */
export function resolveProposalChangeIndex(
	proposalChanges: ChangeItem[],
	change: ChangeItem,
): number {
	if (change.sourceChangeKey) {
		const byKey = proposalChanges.findIndex(
			(c) => c.sourceChangeKey === change.sourceChangeKey,
		);
		if (byKey >= 0) {
			return byKey;
		}
	}
	if (change.sourceRef) {
		const byRef = proposalChanges.findIndex(
			(c) =>
				c.sourceRef === change.sourceRef &&
				c.type === change.type &&
				c.action === change.action,
		);
		if (byRef >= 0) {
			return byRef;
		}
	}
	return proposalChanges.findIndex(
		(c) =>
			c.action === change.action &&
			c.type === change.type &&
			c.title.to === change.title.to &&
			(c.parentFeatureIdentifier ?? null) ===
				(change.parentFeatureIdentifier ?? null) &&
			(c.parentEpicIdentifier ?? null) ===
				(change.parentEpicIdentifier ?? null),
	);
}

/** Extract the `changes[]` array from a stored proposal JSON blob. */
export function readProposalChanges(raw: unknown): ChangeItem[] {
	if (
		raw &&
		typeof raw === "object" &&
		"changes" in raw &&
		Array.isArray((raw as { changes: unknown }).changes)
	) {
		return (raw as { changes: ChangeItem[] }).changes;
	}
	return [];
}

/** Per-change PM-sync override as sent by the review UI. */
export type PmSyncOverride = { pushAnyway?: boolean; skip?: boolean };

/**
 * Re-key `pmSyncOverrides` after already-applied changes are filtered out
 * of `approvedChanges`.
 *
 * The review UI keys overrides by position in the `approvedChanges` array
 * it submits, and `backlogApplyChangesWorkflow` looks them up by position in
 * the array it receives. When a retry drops already-applied changes, the
 * surviving changes shift left, so each override must move with its change:
 * for the change at original position `keptOriginalPositions[q]`, the
 * override lands at new position `q`. Overrides for dropped positions (and
 * keys that are not valid positions) are discarded.
 */
export function remapPmSyncOverrides(
	overrides: Record<string | number, PmSyncOverride>,
	keptOriginalPositions: number[],
): Record<number, PmSyncOverride> {
	const remapped: Record<number, PmSyncOverride> = {};
	keptOriginalPositions.forEach((originalPosition, newPosition) => {
		const override = overrides[originalPosition];
		if (override !== undefined) {
			remapped[newPosition] = override;
		}
	});
	return remapped;
}
