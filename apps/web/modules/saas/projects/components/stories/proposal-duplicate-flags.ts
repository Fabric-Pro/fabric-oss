/**
 * Possible-duplicate flags on an open inbox proposal, and the one action that
 * changes the review: "Use as Enrich target" on a matched ticket.
 *
 * That action reuses the existing Create-vs-Enrich routing override, so the
 * approve payload, the Apply gate and the routing control all treat it like
 * any other reviewer re-route. A row from a source without routing has no
 * annotation for an override to act on, so one is synthesized from the row's
 * own proposed content, exactly what a routed row carries as captured.
 */

import type {
	RoutingAnnotation,
	RoutingOverride,
} from "./ProposalRoutingControl";

export type ProposalDuplicateStoryMatch = {
	kind: "story";
	storyId: string;
	identifier: string;
	title: string;
	similarity: number;
};

/** An unreviewed item of a pending proposal, this one or another. */
export type ProposalDuplicateItemMatch = {
	kind: "proposal_item";
	proposalId: string;
	matchChangeIndex: number;
	title: string;
	similarity: number;
};

export type ProposalDuplicateMatch =
	| ProposalDuplicateStoryMatch
	| ProposalDuplicateItemMatch;

/** Matches by item index; only flagged items have an entry. */
export type ProposalDuplicateFlags = ReadonlyMap<
	number,
	ProposalDuplicateMatch[]
>;

export const NO_DUPLICATE_FLAGS: ProposalDuplicateFlags = new Map();

/** One open proposal's flags, and the indexes of its items still being
 * checked for duplicates. */
export type ProposalDuplicateReview = {
	flags: ProposalDuplicateFlags;
	checking: ReadonlySet<number>;
};

export const NO_DUPLICATE_REVIEW: ProposalDuplicateReview = {
	flags: NO_DUPLICATE_FLAGS,
	checking: new Set(),
};

/** Similarity as a whole percentage, for display. */
export function similarityPercent(similarity: number): number {
	return Math.round(Math.min(1, Math.max(0, similarity)) * 100);
}

/** The wire flags as a lookup by item index. */
export function duplicateFlagsByIndex(
	flags: readonly {
		changeIndex: number;
		matches: ProposalDuplicateMatch[];
	}[],
): ProposalDuplicateFlags {
	return new Map(
		flags
			.filter((flag) => flag.matches.length > 0)
			.map((flag) => [flag.changeIndex, flag.matches]),
	);
}

type InboxItemRow = { proposalId: string; changeIndex: number };

type InboxFlagRow = InboxItemRow & { matches: ProposalDuplicateMatch[] };

/** One proposal's part of the inbox's duplicate check. */
export function duplicateReviewOf(
	answer: {
		flags: readonly InboxFlagRow[];
		checking: readonly InboxItemRow[];
	},
	proposalId: string,
): ProposalDuplicateReview {
	const own = <T extends InboxItemRow>(rows: readonly T[]) =>
		rows.filter((row) => row.proposalId === proposalId);
	return {
		flags: duplicateFlagsByIndex(own(answer.flags)),
		checking: new Set(own(answer.checking).map((row) => row.changeIndex)),
	};
}

type FlaggableChange = {
	title: { to: string };
	description?: { to: string };
	acceptanceCriteria?: { to: string };
};

/**
 * A routing annotation for a row that has none, built from the row's own
 * proposed content: the system's call stays "create", and the matched ticket
 * is offered as the suggestion.
 */
export function duplicateRoutingAnnotation(
	change: FlaggableChange,
	match: ProposalDuplicateStoryMatch,
): RoutingAnnotation {
	const percent = similarityPercent(match.similarity);
	return {
		decision: "create",
		confidence: match.similarity,
		reasoning: `Flagged as a possible duplicate of ${match.identifier} (${percent}% similar).`,
		proposedTitle: change.title.to,
		proposedDescription: change.description?.to ?? null,
		proposedAcceptanceCriteria: change.acceptanceCriteria?.to ?? null,
		alternatives: [
			{
				storyId: match.storyId,
				identifier: match.identifier,
				title: match.title,
				similarity: match.similarity,
			},
		],
	};
}

/**
 * The override that enriches the matched ticket. Duplicate matching reads
 * active tickets only, so the target is not closed.
 */
export function enrichOverrideFor(
	match: ProposalDuplicateStoryMatch,
): RoutingOverride {
	return {
		decision: "enrich",
		target: {
			storyId: match.storyId,
			identifier: match.identifier,
			title: match.title,
			closed: false,
		},
	};
}

/** `changes` with a synthesized annotation on rows that have none. */
export function withDuplicateRouting<
	T extends { routing?: RoutingAnnotation | null },
>(changes: T[], synthesized: ReadonlyMap<number, RoutingAnnotation>): T[] {
	if (synthesized.size === 0) {
		return changes;
	}
	return changes.map((change, index) => {
		const routing = synthesized.get(index);
		return routing && !change.routing ? { ...change, routing } : change;
	});
}
