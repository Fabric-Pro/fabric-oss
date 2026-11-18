/**
 * Pure scoring for duplicate detection against the Proposal Inbox: a manual
 * entry against pending inbox items, and every pending inbox item against
 * roadmap tickets and the rest of the inbox.
 *
 * Roadmap tickets come from the shortlist the manual-create duplicate check
 * judges (`routingShortlist` in `@repo/temporal/backlog-routing-core`). That
 * shortlist's floor is a coarse funnel whose precision comes from the
 * routing judge, so a shortlist ticket is shown only when:
 *   - its similarity reaches the duplicate bar below (`confidentTickets`),
 *     with no judge; or
 *   - the item's best ticket is under that bar and the routing judge, run
 *     as `stories.checkDuplicate` runs it, returns `enrich` for it. Only
 *     the strongest `MAX_VERIFIED_INBOX_ITEMS` such items per call are
 *     judged (`judgeBand`), which bounds the model cost of one call.
 *
 * Inbox items against each other use plain cosine similarity at or above
 * the same bar, the roadmap duplicate scan's candidate bar
 * (`CANDIDATE_COSINE_THRESHOLD`): both sides are work items written in the
 * same register, which is what that bar was calibrated for. Nothing here
 * blocks or acts.
 */

import { CANDIDATE_COSINE_THRESHOLD, cosineSimilarity } from "@repo/database";

/** Similarity a match must reach to be shown without a judge. */
export const PROPOSAL_DUPLICATE_THRESHOLD = CANDIDATE_COSINE_THRESHOLD;

/** Inbox matches shown for one manual entry. */
export const MAX_MANUAL_ENTRY_MATCHES = 5;

/** Matches shown per flagged inbox item. */
export const MAX_FLAG_MATCHES_PER_ITEM = 3;

/** Inbox items per call the routing judge verifies. */
export const MAX_VERIFIED_INBOX_ITEMS = 8;

/** The shortlist tickets at or above the duplicate bar: shown unjudged. */
export function confidentTickets<T extends { similarity: number }>(
	shortlist: readonly T[],
): T[] {
	return shortlist.filter(
		(ticket) => ticket.similarity >= PROPOSAL_DUPLICATE_THRESHOLD,
	);
}

/**
 * Positions of the items the routing judge verifies: those with a shortlist
 * whose best ticket is below the duplicate bar, strongest first, at most
 * `MAX_VERIFIED_INBOX_ITEMS`.
 */
export function judgeBand(
	shortlists: readonly (readonly { similarity: number }[])[],
): number[] {
	const bestOf = (shortlist: readonly { similarity: number }[]) =>
		Math.max(...shortlist.map((ticket) => ticket.similarity));
	return shortlists
		.flatMap((shortlist, index) =>
			shortlist.length > 0 ? [{ index, best: bestOf(shortlist) }] : [],
		)
		.filter((item) => item.best < PROPOSAL_DUPLICATE_THRESHOLD)
		.sort((a, b) => b.best - a.best)
		.slice(0, MAX_VERIFIED_INBOX_ITEMS)
		.map((item) => item.index);
}

/** The candidates at or above `threshold`, strongest first, at most `limit`. */
export function rankSimilar<T extends { embedding: number[] }>(
	query: number[],
	candidates: readonly T[],
	limit: number,
	threshold: number = PROPOSAL_DUPLICATE_THRESHOLD,
): { candidate: T; similarity: number }[] {
	return candidates
		.map((candidate) => ({
			candidate,
			similarity: cosineSimilarity(query, candidate.embedding),
		}))
		.filter((scored) => scored.similarity >= threshold)
		.sort((a, b) => b.similarity - a.similarity)
		.slice(0, limit);
}

/** One pending inbox item similar to a manually entered work item. */
export interface ProposalInboxMatch {
	proposalId: string;
	changeIndex: number;
	title: string;
	/** The proposal's own headline, for context. */
	summary: string;
	/** The proposal's source (`PendingBacklogProposalSource`). */
	source: string;
	similarity: number;
}

/** A roadmap ticket on an item's routing shortlist. */
interface StoryShortlistEntry {
	storyId: string;
	identifier: string;
	title: string;
	similarity: number;
}

type ProposalDuplicateMatch =
	| ({ kind: "story" } & StoryShortlistEntry)
	| {
			kind: "proposal_item";
			proposalId: string;
			matchChangeIndex: number;
			title: string;
			similarity: number;
	  };

/** A pending inbox item and what it may duplicate. */
export interface ProposalDuplicateFlag {
	proposalId: string;
	changeIndex: number;
	matches: ProposalDuplicateMatch[];
}

interface EmbeddedItem {
	proposalId: string;
	changeIndex: number;
	title: string;
	embedding: number[];
	/** The item's ticket shortlist; empty when the Roadmap has no tickets. */
	storyMatches: readonly StoryShortlistEntry[];
}

const itemKey = (proposalId: string, changeIndex: number) =>
	`${proposalId}:${changeIndex}`;

/**
 * Flags for inbox items: each item's ticket shortlist plus the other inbox
 * items (its siblings included) at or above the threshold, strongest first.
 * Items with no match are left out, so an empty array means "nothing to
 * flag".
 */
export function buildDuplicateFlags(params: {
	items: readonly EmbeddedItem[];
	limit?: number;
	threshold?: number;
}): ProposalDuplicateFlag[] {
	const limit = params.limit ?? MAX_FLAG_MATCHES_PER_ITEM;
	const itemCandidates = params.items.map((item) => ({
		key: itemKey(item.proposalId, item.changeIndex),
		embedding: item.embedding,
		match: {
			kind: "proposal_item" as const,
			proposalId: item.proposalId,
			matchChangeIndex: item.changeIndex,
			title: item.title,
		},
	}));

	return params.items.flatMap((item): ProposalDuplicateFlag[] => {
		const self = itemKey(item.proposalId, item.changeIndex);
		const itemMatches = rankSimilar(
			item.embedding,
			itemCandidates.filter((candidate) => candidate.key !== self),
			limit,
			params.threshold,
		).map(
			({ candidate, similarity }): ProposalDuplicateMatch => ({
				...candidate.match,
				similarity,
			}),
		);
		const storyMatches = item.storyMatches.map(
			(story): ProposalDuplicateMatch => ({ kind: "story", ...story }),
		);
		const matches = [...itemMatches, ...storyMatches]
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, limit);
		return matches.length > 0
			? [
					{
						proposalId: item.proposalId,
						changeIndex: item.changeIndex,
						matches,
					},
				]
			: [];
	});
}
