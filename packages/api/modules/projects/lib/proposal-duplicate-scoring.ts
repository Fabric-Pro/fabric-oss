/**
 * Pure scoring for duplicate detection against the Proposal Inbox: a manual
 * entry against pending inbox items, and every pending inbox item against
 * roadmap tickets and the rest of the inbox.
 *
 * A pair is a candidate when the roadmap duplicate scan's own candidate rule
 * (`scoreDetectionPair` in `@repo/database`) selects it: the same threshold,
 * the same proximity relaxation, and, for two features that both have a
 * Scope (or acceptance-criteria) section, the same Scope weighting. As on
 * the roadmap, a candidate is shown only once the scan's duplicate verifier
 * has confirmed it, with the score the rule gave it. An inbox item's pairs
 * are confirmed by their stored verdicts (`settleCandidates`); a candidate
 * with no verdict on its current texts is not shown, and its item is still
 * being checked. A pair the verifier flagged stays a candidate after the
 * rule's score for it drops under the threshold (`candidateMatches`).
 *
 * Nothing here blocks or acts.
 */

import {
	type DetectionItem,
	type InboxDuplicatePair,
	type InboxItemRef,
	type InboxPairCounterpart,
	type InboxVerdictRow,
	inboxVerdictKey,
	inboxVerdictState,
	orderInboxPair,
	type PairFocusKind,
	scoreDetectionPair,
	storedInboxVerdictKey,
} from "@repo/database";

/** Inbox matches shown for one manual entry. */
export const MAX_MANUAL_ENTRY_MATCHES = 5;

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

/** A roadmap ticket an inbox item may duplicate. */
interface StoryMatchEntry {
	storyId: string;
	identifier: string;
	title: string;
	similarity: number;
}

export type ProposalDuplicateMatch =
	| ({ kind: "story" } & StoryMatchEntry)
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

/** A pending inbox item as the roadmap candidate rule scores it. */
export interface ScoredInboxItem {
	proposalId: string;
	changeIndex: number;
	title: string;
	detection: DetectionItem;
	/** `detectionVerdictHash` of the item's verdict subject. */
	verdictHash: string;
}

/** A roadmap ticket as the roadmap candidate rule scores it. */
export interface ScoredTicket {
	storyId: string;
	identifier: string;
	title: string;
	detection: DetectionItem;
	/** `detectionVerdictHash` of the ticket's verdict subject. */
	verdictHash: string;
}

/** What the candidate rule found for a pair it selects: the verifier reads
 * the pair as the scan would. */
export interface PairCandidate {
	score: number;
	proximate: boolean;
	focusKind: PairFocusKind | null;
}

/**
 * What the rule finds for the pair, and whether it selects it: the pair's
 * score reaches its own threshold, which is lower for items created close
 * together, exactly as in the roadmap scan.
 */
function rulePair(
	first: DetectionItem,
	second: DetectionItem,
): { found: PairCandidate; selected: boolean } {
	const { threshold, ...found } = scoreDetectionPair(first, second);
	return { found, selected: found.score >= threshold };
}

/** The rule's finding when it selects the pair, else null. */
function selectedPair(
	first: DetectionItem,
	second: DetectionItem,
): PairCandidate | null {
	const { found, selected } = rulePair(first, second);
	return selected ? found : null;
}

/**
 * The candidates the roadmap candidate rule selects against `entry`, each
 * with what the rule found, strongest first, at most `limit`.
 */
export function rankCandidates<T extends { detection: DetectionItem }>(
	entry: DetectionItem,
	candidates: readonly T[],
	limit: number,
): { candidate: T; found: PairCandidate }[] {
	return candidates
		.flatMap((candidate) => {
			const found = selectedPair(entry, candidate.detection);
			return found === null ? [] : [{ candidate, found }];
		})
		.sort((a, b) => b.found.score - a.found.score)
		.slice(0, limit);
}

/** A candidate match of an inbox item: the match as it would be shown, the
 * pair to verify, and both sides' verdict hashes. */
export interface CandidateMatch {
	match: ProposalDuplicateMatch;
	pair: InboxDuplicatePair;
	hashes: { item: string; counterpart: string };
}

/** A stored verdict on an inbox pair, with the keys of its row. */
type StoredInboxVerdict = InboxVerdictRow & {
	proposalId: string;
	changeIndex: number;
	counterpartKey: string;
};

/**
 * Each inbox item's candidates, in item order: the tickets and the other
 * inbox items (its siblings included, never itself) the roadmap candidate
 * rule selects, each with the score the rule gave it.
 *
 * A pair the verifier has flagged stays a candidate, with the rule's
 * current score, when the rule no longer selects it: the score of an
 * unchanged pair moves when a side's section vectors are cached or dropped,
 * and that must not hide a confirmed duplicate, or skip verifying it again
 * once a side's text changed.
 */
export function candidateMatches(params: {
	items: readonly ScoredInboxItem[];
	tickets: readonly ScoredTicket[];
	verdicts: readonly StoredInboxVerdict[];
}): CandidateMatch[][] {
	const flagged = new Set(
		params.verdicts.flatMap((verdict) =>
			verdict.flagged === true ? [storedInboxVerdictKey(verdict)] : [],
		),
	);
	return params.items.map((item, index) => {
		const ref: InboxItemRef = {
			proposalId: item.proposalId,
			changeIndex: item.changeIndex,
		};
		const pairWith = (
			counterpart: InboxPairCounterpart,
			other: { detection: DetectionItem; verdictHash: string },
		): Omit<CandidateMatch, "match"> | null => {
			const { found, selected } = rulePair(
				item.detection,
				other.detection,
			);
			const ordered = orderInboxPair(ref, counterpart);
			if (
				!selected &&
				!flagged.has(inboxVerdictKey(ordered.item, ordered.counterpart))
			) {
				return null;
			}
			return {
				pair: {
					item: ref,
					counterpart,
					similarity: found.score,
					proximate: found.proximate,
					focusKind: found.focusKind,
				},
				hashes: {
					item: item.verdictHash,
					counterpart: other.verdictHash,
				},
			};
		};
		const itemMatches = params.items.flatMap(
			(other, otherIndex): CandidateMatch[] => {
				if (otherIndex === index) {
					return [];
				}
				const counterpart: InboxPairCounterpart = {
					kind: "item",
					proposalId: other.proposalId,
					changeIndex: other.changeIndex,
				};
				const found = pairWith(counterpart, other);
				if (found === null) {
					return [];
				}
				const match: ProposalDuplicateMatch = {
					kind: "proposal_item",
					proposalId: other.proposalId,
					matchChangeIndex: other.changeIndex,
					title: other.title,
					similarity: found.pair.similarity,
				};
				return [{ ...found, match }];
			},
		);
		const ticketMatches = params.tickets.flatMap(
			(ticket): CandidateMatch[] => {
				const counterpart: InboxPairCounterpart = {
					kind: "story",
					storyId: ticket.storyId,
				};
				const found = pairWith(counterpart, ticket);
				if (found === null) {
					return [];
				}
				const match: ProposalDuplicateMatch = {
					kind: "story",
					storyId: ticket.storyId,
					identifier: ticket.identifier,
					title: ticket.title,
					similarity: found.pair.similarity,
				};
				return [{ ...found, match }];
			},
		);
		return [...itemMatches, ...ticketMatches];
	});
}

/** Each item's candidates settled by the verifier's stored verdicts. */
interface SettledCandidates {
	/** Per item, in item order: the matches a current verdict flagged. */
	matches: ProposalDuplicateMatch[][];
	/** Per item, in item order: whether a candidate has no current
	 * verdict yet. */
	waiting: boolean[];
	/** The candidate pairs with no current verdict, each once, in item
	 * order. */
	unverified: InboxDuplicatePair[];
}

/**
 * Settle each item's candidates by the stored verdicts at `now` (epoch ms):
 * a candidate whose verdict was given on both current texts is shown when it
 * was flagged and dropped when not; one whose verification keeps failing on
 * them and waits is dropped too, and does not keep its item waiting; any
 * other candidate is not shown, waits for the verifier, and is listed to
 * verify.
 */
export function settleCandidates(
	candidates: readonly CandidateMatch[][],
	verdicts: readonly StoredInboxVerdict[],
	now: number,
): SettledCandidates {
	const byKey = new Map(
		verdicts.map((verdict) => [storedInboxVerdictKey(verdict), verdict]),
	);
	const unverified = new Map<string, InboxDuplicatePair>();
	const matches: ProposalDuplicateMatch[][] = [];
	const waiting: boolean[] = [];
	for (const itemCandidates of candidates) {
		const shown: ProposalDuplicateMatch[] = [];
		let waits = false;
		for (const { match, pair, hashes } of itemCandidates) {
			const ordered = orderInboxPair(pair.item, pair.counterpart);
			const key = inboxVerdictKey(ordered.item, ordered.counterpart);
			const storedHashes = ordered.swapped
				? { item: hashes.counterpart, counterpart: hashes.item }
				: hashes;
			const state = inboxVerdictState(
				byKey.get(key) ?? null,
				storedHashes,
				now,
			);
			switch (state) {
				case "flagged":
					shown.push(match);
					break;
				case "clear":
				case "backing_off":
					break;
				case "unverified":
					waits = true;
					if (!unverified.has(key)) {
						unverified.set(key, pair);
					}
					break;
				default: {
					const unhandled: never = state;
					return unhandled;
				}
			}
		}
		matches.push(shown);
		waiting.push(waits);
	}
	return { matches, waiting, unverified: Array.from(unverified.values()) };
}

/**
 * Flags for inbox items: every confirmed match of each item, strongest
 * first. Items with no match are left out, so an empty array means
 * "nothing to flag".
 */
export function buildDuplicateFlags(params: {
	items: readonly {
		proposalId: string;
		changeIndex: number;
		matches: readonly ProposalDuplicateMatch[];
	}[];
}): ProposalDuplicateFlag[] {
	return params.items.flatMap((item): ProposalDuplicateFlag[] => {
		const matches = [...item.matches].sort(
			(a, b) => b.similarity - a.similarity,
		);
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
