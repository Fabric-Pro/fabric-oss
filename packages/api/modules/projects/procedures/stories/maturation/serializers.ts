import type { DecisionLogThread } from "@repo/database";
import type { CleanSpecPropagationSummary } from "./schemas";

const PROPAGATION_STATUSES = [
	"applied",
	"pending",
	"refused",
	"noop",
	"skipped",
	"error",
] as const;

/**
 * Derive the editor-facing Clean-Spec propagation summary from a decision root's
 * `metadata.cleanSpecPropagation` (written by TG4 / the accept flow). Returns
 * `null` for decisions that never ran propagation (e.g. an OPEN question).
 */
function derivePropagation(
	metadata: DecisionLogThread["root"]["metadata"],
): CleanSpecPropagationSummary {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return null;
	}
	const prop = (metadata as Record<string, unknown>).cleanSpecPropagation;
	if (!prop || typeof prop !== "object" || Array.isArray(prop)) {
		return null;
	}
	const p = prop as Record<string, unknown>;
	const status = PROPAGATION_STATUSES.find((s) => s === p.status);
	if (!status) {
		return null;
	}
	return {
		status,
		appliedSummaries: Array.isArray(p.appliedSummaries)
			? p.appliedSummaries.filter(
					(s): s is string => typeof s === "string",
				)
			: [],
		pendingPatchCount: Array.isArray(p.pendingPatches)
			? p.pendingPatches.length
			: 0,
	};
}

interface SuggestedOption {
	text: string;
	justification: string;
}

/**
 * Derive the AI answer recommendations for a question root from
 * `metadata.answerRecommendation` (written by `proposeQuestionAnswers`, #7). Returns
 * `{ suggestedOptions: [] }` when none was produced — the shape the DTO/UI treats as
 * "no recommendation".
 *
 * Tolerates the LEGACY shape from the first cut (`{ suggestedAnswer: string|null,
 * suggestedOptions: string[] }`, no justifications) so pre-existing rows don't crash;
 * legacy options derive with an empty justification (the UI omits the line).
 */
function deriveRecommendation(
	metadata: DecisionLogThread["root"]["metadata"],
): { suggestedOptions: SuggestedOption[] } {
	const empty = { suggestedOptions: [] as SuggestedOption[] };
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return empty;
	}
	const rec = (metadata as Record<string, unknown>).answerRecommendation;
	if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
		return empty;
	}
	const r = rec as Record<string, unknown>;

	// Current shape: options: [{ text, justification }].
	if (Array.isArray(r.options)) {
		const options: SuggestedOption[] = [];
		for (const o of r.options) {
			if (!o || typeof o !== "object") {
				continue;
			}
			const text = (o as { text?: unknown }).text;
			const justification = (o as { justification?: unknown })
				.justification;
			if (typeof text === "string" && text.trim()) {
				options.push({
					text,
					justification:
						typeof justification === "string" ? justification : "",
				});
			}
		}
		return { suggestedOptions: options };
	}

	// Legacy shape: { suggestedAnswer, suggestedOptions: string[] } (no justifications).
	const legacy: SuggestedOption[] = [];
	if (typeof r.suggestedAnswer === "string" && r.suggestedAnswer.trim()) {
		legacy.push({ text: r.suggestedAnswer, justification: "" });
	}
	if (Array.isArray(r.suggestedOptions)) {
		for (const s of r.suggestedOptions) {
			if (typeof s === "string" && s.trim()) {
				legacy.push({ text: s, justification: "" });
			}
		}
	}
	return { suggestedOptions: legacy };
}

/**
 * Map a query-layer thread (root + replies) to the `DecisionLogThreadSchema` DTO,
 * shared by `getEditorState` and `listDecisionLog` so the two never drift. The
 * rows carry the Prisma enum types (`status`, `authorType`, `source`), so the
 * mapped object matches the enum-typed `.output()` schema — do NOT widen these.
 *
 * `includeRecommendations` (#7, FR-15): when false, AI answer options are stripped
 * (`suggestedOptions: []`) so the org dogfood flag hides the feature at the DISPLAY
 * layer too — not just generation. Without this, options already persisted in
 * `metadata` (e.g. minted while the flag was on) would keep rendering after the flag
 * is turned off, violating the "flag disabled → no option controls" acceptance.
 */
export function serializeDecisionLogThread(
	thread: DecisionLogThread,
	{
		includeRecommendations = true,
	}: { includeRecommendations?: boolean } = {},
) {
	return {
		root: {
			id: thread.root.id,
			status: thread.root.status,
			summary: thread.root.summary,
			content: thread.root.content,
			impactedSection: thread.root.impactedSection,
			topic: thread.root.topic,
			questionId: thread.root.questionId,
			authorType: thread.root.authorType,
			source: thread.root.source,
			decidedBy: thread.root.decidedBy,
			authorName: thread.root.authorName,
			sourceProvenance: thread.root.sourceProvenance,
			createdAt: thread.root.createdAt,
			supersedesId: thread.root.supersedesId,
			cleanSpecPropagation: derivePropagation(thread.root.metadata),
			suggestedOptions: includeRecommendations
				? deriveRecommendation(thread.root.metadata).suggestedOptions
				: [],
		},
		replies: thread.replies.map((reply) => ({
			id: reply.id,
			status: reply.status,
			summary: reply.summary,
			content: reply.content,
			authorType: reply.authorType,
			source: reply.source,
			authorName: reply.authorName,
			sourceProvenance: reply.sourceProvenance,
			createdAt: reply.createdAt,
			supersedesId: reply.supersedesId,
		})),
	};
}
