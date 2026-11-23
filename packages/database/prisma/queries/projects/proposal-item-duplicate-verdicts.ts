/**
 * The duplicate verifier's verdicts on Proposal Inbox items
 * (`ProposalItemDuplicateVerdict`). The inbox's read path reads them to show
 * only confirmed pairs; the verification workflow writes them. Pairs and
 * keys are in `proposal-item-duplicate-pairs.ts`; every function here takes
 * a pair in stored order (`orderInboxPair`).
 */

import { db } from "../../client";
import type { DuplicateLinkType } from "../../generated/enums";
import {
	type InboxItemRef,
	type InboxPairCounterpart,
	inboxCounterpartKey,
} from "./proposal-item-duplicate-pairs";

const VERDICT_SELECT = {
	proposalId: true,
	changeIndex: true,
	counterpartKey: true,
	contentHash: true,
	counterpartHash: true,
	flagged: true,
	linkType: true,
	confidence: true,
	failedAttempts: true,
	lastFailedAt: true,
} as const;

export type InboxDuplicateVerdict = Awaited<
	ReturnType<typeof listProposalItemDuplicateVerdicts>
>[number];

/** The verdicts on the items of a project's PENDING proposals. */
export async function listProposalItemDuplicateVerdicts(projectId: string) {
	return await db.proposalItemDuplicateVerdict.findMany({
		where: { proposal: { projectId, status: "PENDING" } },
		select: VERDICT_SELECT,
	});
}

function pairWhere(item: InboxItemRef, counterpart: InboxPairCounterpart) {
	return {
		proposalId: item.proposalId,
		changeIndex: item.changeIndex,
		counterpartKey: inboxCounterpartKey(counterpart),
	};
}

/** The stored verdict on one pair, or null. */
export async function getProposalItemDuplicateVerdict(
	item: InboxItemRef,
	counterpart: InboxPairCounterpart,
): Promise<InboxDuplicateVerdict | null> {
	return await db.proposalItemDuplicateVerdict.findUnique({
		where: {
			proposalId_changeIndex_counterpartKey: pairWhere(item, counterpart),
		},
		select: VERDICT_SELECT,
	});
}

/** Store a verdict on a pair, replacing an older one and clearing any
 * failures. */
export async function upsertProposalItemDuplicateVerdict(params: {
	item: InboxItemRef;
	counterpart: InboxPairCounterpart;
	hashes: { item: string; counterpart: string };
	flagged: boolean;
	linkType: DuplicateLinkType;
	similarity: number;
	confidence: number;
	reasoning?: string | null;
}): Promise<void> {
	const pair = pairWhere(params.item, params.counterpart);
	const fields = {
		contentHash: params.hashes.item,
		counterpartHash: params.hashes.counterpart,
		flagged: params.flagged,
		linkType: params.linkType,
		similarity: params.similarity,
		confidence: params.confidence,
		reasoning: params.reasoning ?? null,
		failedAttempts: 0,
		lastFailedAt: null,
	};
	await db.proposalItemDuplicateVerdict.upsert({
		where: { proposalId_changeIndex_counterpartKey: pair },
		create: { ...pair, ...fields },
		update: fields,
	});
}

/**
 * Record a failed verification of a pair on these texts: one more failure
 * in a row when the row's hashes are these, else the first. Any earlier
 * verdict's state is kept, for the second opinion of the next try; a new
 * row has none (`flagged` null).
 */
export async function recordProposalItemDuplicateVerdictFailure(params: {
	item: InboxItemRef;
	counterpart: InboxPairCounterpart;
	hashes: { item: string; counterpart: string };
	similarity: number;
}): Promise<void> {
	const pair = pairWhere(params.item, params.counterpart);
	const where = { proposalId_changeIndex_counterpartKey: pair };
	const existing = await db.proposalItemDuplicateVerdict.findUnique({
		where,
		select: {
			contentHash: true,
			counterpartHash: true,
			failedAttempts: true,
		},
	});
	const failedAttempts =
		existing?.contentHash === params.hashes.item &&
		existing.counterpartHash === params.hashes.counterpart
			? existing.failedAttempts + 1
			: 1;
	const failure = {
		contentHash: params.hashes.item,
		counterpartHash: params.hashes.counterpart,
		lastFailedAt: new Date(),
	};
	await db.proposalItemDuplicateVerdict.upsert({
		where,
		create: {
			...pair,
			...failure,
			similarity: params.similarity,
			failedAttempts: 1,
		},
		update: { ...failure, failedAttempts },
	});
}

/**
 * Stamp the current hashes on a stored verdict without changing it: a
 * re-check that would have changed the pair's state, but that a second
 * opinion did not back, keeps the state and is not re-billed until one side
 * changes again.
 */
export async function stampProposalItemDuplicateVerdict(params: {
	item: InboxItemRef;
	counterpart: InboxPairCounterpart;
	hashes: { item: string; counterpart: string };
}): Promise<void> {
	await db.proposalItemDuplicateVerdict.updateMany({
		where: pairWhere(params.item, params.counterpart),
		data: {
			contentHash: params.hashes.item,
			counterpartHash: params.hashes.counterpart,
			failedAttempts: 0,
			lastFailedAt: null,
		},
	});
}
