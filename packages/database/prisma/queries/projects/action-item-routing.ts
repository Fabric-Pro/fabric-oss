/**
 * Create-vs-Enrich routing for action items extracted from ingested meeting
 * transcripts and monitored chat threads.
 *
 * WHAT IS NO LONGER HERE, and why that matters more than what is:
 *
 * This module used to carry its own text builder, content-hash, cosine floor,
 * candidate cap, ranking function, candidate loader and embedding-cache table.
 * Every one of those already existed — `buildDetectionText` and
 * `hashDetectionText` in `duplicate-detection.ts`, `listActiveStoriesForDetection`
 * in `duplicate-links.ts`, and `selectCandidates` with its floor and cap in
 * `action-item-link-core.ts`, which matches meeting action items against work
 * items for the meeting digest — the same question this pass asks.
 *
 * Three consequences of the duplication, all now gone: the three matchers could
 * silently disagree about what a ticket "is"; a shared embedding cache keyed on
 * content hash would have thrashed, because two features computed different text
 * for the same story; and a change to how matching behaves had to be made in
 * several places to take effect. Matching now lives in one place, and routing
 * shares the `StoryDuplicateEmbedding` cache with the duplicate scan and the
 * digest linker rather than maintaining a second copy of the same vectors.
 *
 * What remains here is only what is genuinely routing's own: the judge's
 * confidence bar and the judge prompt.
 */

/**
 * Minimum judge confidence for an action item to be routed to Enrich. At or
 * below this the item stays a Create — the safe direction, since a spurious
 * Create is caught by duplicate detection afterwards while a spurious Enrich
 * silently edits the wrong ticket.
 *
 * Matches `DEFAULT_MIN_CONFIDENCE` in `action-item-link-core.ts` deliberately:
 * the two features ask a model the same question about the same kind of pair,
 * so they should demand the same certainty before acting on the answer.
 */
export const DEFAULT_ROUTING_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Read a threshold override from the environment, falling back to the default
 * when unset, unparseable, or outside 0..1. The card's Admin/Configuration rule
 * requires these to be tunable by the development team without being exposed to
 * end users — an env var on the worker is exactly that.
 */
export function resolveRoutingThreshold(
	raw: string | undefined,
	fallback: number,
): number {
	if (raw === undefined || raw.trim() === "") {
		return fallback;
	}
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		return fallback;
	}
	return parsed;
}

/** Effective judge threshold, honouring `ACTION_ITEM_ROUTING_CONFIDENCE_THRESHOLD`. */
export function routingConfidenceThreshold(): number {
	return resolveRoutingThreshold(
		process.env.ACTION_ITEM_ROUTING_CONFIDENCE_THRESHOLD,
		DEFAULT_ROUTING_CONFIDENCE_THRESHOLD,
	);
}

export type RoutingJudgeCandidate = {
	identifier: string;
	title: string;
	content: string;
};

/**
 * Fallback text for the routing judge.
 *
 * The prompt an operator can edit lives in the prompt library, bound to the
 * routing judge agent; this is what renders when no binding resolves, so a
 * missing or unseeded binding degrades to the shipped wording rather than to no
 * prompt at all. Keep the two in step: an edit here that never reaches the seed
 * is invisible to every environment where a binding exists.
 *
 * Biased toward Create: enriching the wrong ticket edits a record the team
 * already relies on, whereas a spurious Create is caught downstream by the
 * existing duplicate-detection scan. The model answers with an identifier
 * (never an internal id) so a hallucinated value fails the caller's lookup
 * instead of silently addressing some other row.
 */
export function buildRoutingJudgePrompt(params: {
	actionItem: string;
	reasoning?: string | null;
	candidates: RoutingJudgeCandidate[];
}): string {
	const { actionItem, reasoning, candidates } = params;
	const candidateBlock = candidates
		.map(
			(candidate, index) =>
				`### Candidate ${index + 1} — ${candidate.identifier}: ${candidate.title}\n${candidate.content}`,
		)
		.join("\n\n");

	return `You are triaging an action item captured from a team's meeting or chat discussion against that project's existing backlog.

Decide whether the action item describes work that is ALREADY tracked by one of the candidate tickets below — in which case it should ENRICH that ticket with the new detail — or whether it is a distinct piece of work that needs its own new ticket (CREATE).

Answer "enrich" ONLY when the action item is about the SAME underlying piece of work as a candidate: a clarification, an added requirement, a decision, a scope change, or new detail on work that ticket already covers. Answer "create" when the action item covers different work, a different bug, or merely touches the same area or feature as a candidate. When you are unsure, answer "create" — a wrongly created ticket is easy to merge later, a wrongly enriched ticket corrupts a record the team is already working from.

## Action item
${actionItem}${reasoning ? `\n\nWhy it was captured: ${reasoning}` : ""}

## Candidate tickets
${candidateBlock}

Return:
- decision: "enrich" or "create"
- targetIdentifier: the identifier of the candidate to enrich (e.g. ${candidates[0]?.identifier ?? "F-001"}), or null when decision is "create"
- confidence: 0..1, your certainty in the decision
- reasoning: one sentence explaining the decision`;
}
