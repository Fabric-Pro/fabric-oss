/**
 * The pairs the Proposal Inbox's duplicate verifier decides, and what its
 * stored verdicts (`ProposalItemDuplicateVerdict`, read and written in
 * `proposal-item-duplicate-verdicts.ts`) are keyed on.
 *
 * An inbox item is compared with a roadmap ticket or another inbox item. A
 * pair of two inbox items has one verdict, so both of its sides read the same
 * one: `orderInboxPair` puts the sides in stored order. A verdict holds while
 * both sides' verdict hashes (`detectionVerdictHash` of their subjects) still
 * match the texts; a pair whose verification keeps failing on its texts
 * waits before it is tried again (`inboxVerdictState`).
 *
 * Pure (no DB): the inbox's read path and the verification workflow share it.
 */

import type { StoryKind } from "../../generated/enums";
import { detectionTextForStory } from "./duplicate-detection";
import {
	extractFocusTexts,
	type FocusTexts,
	type PairFocusKind,
} from "./duplicate-focus";
import type { PendingProposalMatchItem } from "./pending-proposal-match-items";

/** One side of a pair as the verifier reads it and its verdict is hashed. */
export interface VerdictSubject {
	identifier: string;
	text: string;
	kind: StoryKind;
	focusTexts: FocusTexts | null;
}

/** Shown to the verifier in place of a ticket identifier. */
const INBOX_ITEM_IDENTIFIER = "Proposal Inbox item";

/** An inbox item as a verdict subject. A bug item has no sections (null);
 * any other item is applied as a feature and has them, maybe none. */
export function inboxItemSubject(
	item: PendingProposalMatchItem,
): VerdictSubject {
	return {
		identifier: INBOX_ITEM_IDENTIFIER,
		text: detectionTextForStory(item),
		kind: item.focusTexts ? "FEATURE" : "BUG",
		focusTexts: item.focusTexts,
	};
}

/** A roadmap ticket as a verdict subject, read as the roadmap scan reads
 * it. */
export function storySubject(
	story: Parameters<typeof detectionTextForStory>[0] & {
		identifier: string;
		kind: StoryKind;
	},
): VerdictSubject {
	return {
		identifier: story.identifier,
		text: detectionTextForStory(story),
		kind: story.kind,
		focusTexts: extractFocusTexts(story),
	};
}

/** An inbox item: a proposal and the index of its change. */
export interface InboxItemRef {
	proposalId: string;
	changeIndex: number;
}

/** What an inbox item is compared with. */
export type InboxPairCounterpart =
	| { kind: "story"; storyId: string }
	| { kind: "item"; proposalId: string; changeIndex: number };

/**
 * A candidate pair to verify, with what the candidate rule found for it.
 * Plain data: it is a workflow argument.
 */
export interface InboxDuplicatePair {
	item: InboxItemRef;
	counterpart: InboxPairCounterpart;
	/** The candidate score the pair is shown with. */
	similarity: number;
	proximate: boolean;
	/** The section the pair was scored on, or null for the whole text. */
	focusKind: PairFocusKind | null;
}

function itemKey(item: InboxItemRef): string {
	return `item:${item.proposalId}:${item.changeIndex}`;
}

/** The counterpart as a verdict row stores it. */
export function inboxCounterpartKey(counterpart: InboxPairCounterpart): string {
	switch (counterpart.kind) {
		case "story":
			return `story:${counterpart.storyId}`;
		case "item":
			return itemKey(counterpart);
		default: {
			const unhandled: never = counterpart;
			return unhandled;
		}
	}
}

/**
 * The pair's sides in stored order, and whether they were swapped: a pair
 * of two inbox items is stored on the item whose own key sorts first, so
 * either side reads the same row.
 */
export function orderInboxPair(
	item: InboxItemRef,
	counterpart: InboxPairCounterpart,
): {
	item: InboxItemRef;
	counterpart: InboxPairCounterpart;
	swapped: boolean;
} {
	if (counterpart.kind === "item" && itemKey(counterpart) < itemKey(item)) {
		return {
			item: {
				proposalId: counterpart.proposalId,
				changeIndex: counterpart.changeIndex,
			},
			counterpart: { kind: "item", ...item },
			swapped: true,
		};
	}
	return { item, counterpart, swapped: false };
}

/** A stored verdict's lookup key. */
export function storedInboxVerdictKey(verdict: {
	proposalId: string;
	changeIndex: number;
	counterpartKey: string;
}): string {
	return `${verdict.proposalId}:${verdict.changeIndex}:${verdict.counterpartKey}`;
}

/** The lookup key of a pair in stored order: `storedInboxVerdictKey` of the
 * pair's row. */
export function inboxVerdictKey(
	item: InboxItemRef,
	counterpart: InboxPairCounterpart,
): string {
	return storedInboxVerdictKey({
		proposalId: item.proposalId,
		changeIndex: item.changeIndex,
		counterpartKey: inboxCounterpartKey(counterpart),
	});
}

/** Failed verifications in a row, on the same texts, after which a pair
 * waits {@link INBOX_VERIFY_BACKOFF_MS} before it is tried again. */
export const INBOX_VERIFY_FAILURE_LIMIT = 2;

/** How long a pair that keeps failing waits between tries. */
export const INBOX_VERIFY_BACKOFF_MS = 30 * 60_000;

/** What a pair's stored row says about its two current texts. */
export type InboxVerdictState =
	/** Decided on these texts: shown. */
	| "flagged"
	/** Decided on these texts: not shown. */
	| "clear"
	/** Kept failing on these texts and waits: not shown, not verified. */
	| "backing_off"
	/** No verdict on these texts yet: to verify. */
	| "unverified";

/** What a stored row says about the texts it was decided or failed on. */
export interface InboxVerdictRow {
	contentHash: string;
	counterpartHash: string;
	/** Null until the verifier first decides the pair. */
	flagged: boolean | null;
	failedAttempts: number;
	lastFailedAt: Date | null;
}

/**
 * The state of a pair from its stored row (if any), the hashes in stored
 * order, at `now` (epoch ms).
 */
export function inboxVerdictState(
	stored: InboxVerdictRow | null,
	hashes: { item: string; counterpart: string },
	now: number,
): InboxVerdictState {
	if (
		!stored ||
		stored.contentHash !== hashes.item ||
		stored.counterpartHash !== hashes.counterpart
	) {
		return "unverified";
	}
	if (stored.failedAttempts === 0 && stored.flagged !== null) {
		return stored.flagged ? "flagged" : "clear";
	}
	const backingOff =
		stored.failedAttempts >= INBOX_VERIFY_FAILURE_LIMIT &&
		stored.lastFailedAt !== null &&
		now - stored.lastFailedAt.getTime() < INBOX_VERIFY_BACKOFF_MS;
	return backingOff ? "backing_off" : "unverified";
}
