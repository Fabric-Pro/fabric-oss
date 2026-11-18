/**
 * Per-item "Move to Rejected" for a PENDING or FAILED review-inbox proposal.
 *
 * The item moves into its own BACKLOG row (one change, same source, owner and
 * tenant) so it is listed with the other rejected proposals and Restore &
 * Apply works on it unchanged. The original row records the index under
 * `sourceMetadata.rejectedChangeIndexes`. When the item is the proposal's
 * only one and nothing else was resolved, the whole row moves instead.
 */

import { db, type Prisma } from "../../client";
import { deriveProposalHeadline } from "./pending-backlog-proposals";
import {
	proposalItemStateForRow,
	REJECTED_CHANGE_INDEXES_KEY,
	sourceMetadataEquals,
} from "./pending-proposal-item-state";
import {
	asJsonRecord,
	primaryDraftChangeIndex,
	readStoredProposalChanges,
} from "./proposal-changes";

export type MoveProposalItemResult =
	| { outcome: "moved" }
	| { outcome: "split"; splitProposalId: string }
	| { outcome: "invalid_index" }
	/** The proposal left review, or this item was already resolved. */
	| { outcome: "already_resolved" }
	/** Another change to the proposal landed first; reopen it and retry. */
	| { outcome: "proposal_changed" };

interface MoveProposalItemParams {
	proposalId: string;
	changeIndex: number;
	reviewedBy: string;
}

/** Thrown inside the transaction so the split row rolls back on a lost race. */
class ProposalItemMoveConflict extends Error {}

const toJson = (value: unknown): Prisma.InputJsonValue =>
	JSON.parse(JSON.stringify(value));

/**
 * Keep one item's decision pre-check findings, re-indexed to 0, plus
 * proposal-level findings that carry no change reference.
 */
function findingsForItem(
	findings: unknown[],
	changeIndex: number,
): Record<string, unknown>[] {
	return findings.flatMap((raw): Record<string, unknown>[] => {
		const finding = asJsonRecord(raw);
		if (!finding) {
			return [];
		}
		const changeRef = asJsonRecord(finding.changeRef);
		if (!changeRef) {
			return [finding];
		}
		return changeRef.index === changeIndex
			? [{ ...finding, changeRef: { ...changeRef, index: 0 } }]
			: [];
	});
}

/**
 * Source metadata for the split row: every key is copied except the
 * original's per-item ledger, and index-based pre-check findings are
 * narrowed to this item.
 */
export function splitItemSourceMetadata(
	sourceMetadata: unknown,
	changeIndex: number,
): Prisma.InputJsonValue | undefined {
	const meta = asJsonRecord(sourceMetadata);
	if (!meta) {
		return undefined;
	}
	const { [REJECTED_CHANGE_INDEXES_KEY]: _ledger, ...rest } = meta;
	const precheck = asJsonRecord(rest.decisionPrecheck);
	if (precheck && Array.isArray(precheck.findings)) {
		const findings = findingsForItem(precheck.findings, changeIndex);
		rest.decisionPrecheck = {
			...precheck,
			findings,
			...(findings.length === 0 ? { status: "ok" } : {}),
		};
	}
	return toJson(rest);
}

/** `proposal` JSON for the split row: the original object with one change. */
export function splitItemProposal(
	proposal: unknown,
	item: unknown,
): Prisma.InputJsonValue {
	return toJson({ ...(asJsonRecord(proposal) ?? {}), changes: [item] });
}

/**
 * Copy the original's finished drafts to the split row when the moved item
 * is the one they were drafted for, so Restore & Apply keeps the reviewed
 * body. A draft still running stays with the original.
 */
async function copyItemDrafts(
	tx: Prisma.TransactionClient,
	fromProposalId: string,
	toProposalId: string,
): Promise<void> {
	const drafts = await tx.backlogProposalDraft.findMany({
		where: { proposalId: fromProposalId, status: "COMPLETED" },
		select: {
			kind: true,
			description: true,
			acceptanceCriteria: true,
			needsMoreInfo: true,
			startedAt: true,
			completedAt: true,
			createdBy: true,
		},
	});
	if (drafts.length === 0) {
		return;
	}
	await tx.backlogProposalDraft.createMany({
		data: drafts.map((draft) => ({
			...draft,
			proposalId: toProposalId,
			status: "COMPLETED" as const,
		})),
	});
}

async function moveItemInTransaction(
	tx: Prisma.TransactionClient,
	params: MoveProposalItemParams,
): Promise<MoveProposalItemResult> {
	const row = await tx.pendingBacklogProposal.findUnique({
		where: { id: params.proposalId },
		select: {
			projectId: true,
			source: true,
			status: true,
			proposal: true,
			summary: true,
			changeCount: true,
			sourceMetadata: true,
			appliedChangeIndexes: true,
			appliedAt: true,
			userId: true,
			organizationId: true,
		},
	});
	// Items of a PENDING proposal, or of a FAILED one awaiting Review & retry.
	if (!row || (row.status !== "PENDING" && row.status !== "FAILED")) {
		return { outcome: "already_resolved" };
	}
	const changes = readStoredProposalChanges(row.proposal);
	const item = changes[params.changeIndex];
	if (item === undefined || params.changeIndex >= row.changeCount) {
		return { outcome: "invalid_index" };
	}

	const state = await proposalItemStateForRow(params.proposalId, row, tx);
	if (state.resolved.has(params.changeIndex)) {
		return { outcome: "already_resolved" };
	}

	const reviewedAt = new Date();
	if (state.resolved.size === 0 && state.remainingCount === 1) {
		const moved = await tx.pendingBacklogProposal.updateMany({
			where: { id: params.proposalId, status: row.status },
			data: {
				status: "BACKLOG",
				reviewedAt,
				reviewedBy: params.reviewedBy,
			},
		});
		return moved.count === 1
			? { outcome: "moved" }
			: { outcome: "proposal_changed" };
	}

	const splitProposal = splitItemProposal(row.proposal, item.raw);
	const split = await tx.pendingBacklogProposal.create({
		data: {
			projectId: row.projectId,
			source: row.source,
			status: "BACKLOG",
			proposal: splitProposal,
			summary: deriveProposalHeadline(splitProposal) || row.summary,
			changeCount: 1,
			sourceMetadata: splitItemSourceMetadata(
				row.sourceMetadata,
				params.changeIndex,
			),
			userId: row.userId,
			organizationId: row.organizationId,
			reviewedAt,
			reviewedBy: params.reviewedBy,
		},
		select: { id: true },
	});
	if (primaryDraftChangeIndex(changes) === params.changeIndex) {
		await copyItemDrafts(tx, params.proposalId, split.id);
	}

	// The last unresolved item closes the original: APPLIED when any item
	// was applied, otherwise REJECTED (every item was moved to Rejected).
	// A FAILED original that closes as APPLIED drops its failure.
	const closing = state.remainingCount === 1;
	const nextRejected = [...state.rejected, params.changeIndex].sort(
		(a, b) => a - b,
	);
	const closedStatus =
		state.applied.size > 0
			? {
					status: "APPLIED" as const,
					appliedAt: row.appliedAt ?? reviewedAt,
					applyError: null,
					errorClass: null,
					errorMessage: null,
					failedAt: null,
				}
			: {
					status: "REJECTED" as const,
					reviewedAt,
					reviewedBy: params.reviewedBy,
				};
	const updated = await tx.pendingBacklogProposal.updateMany({
		where: {
			id: params.proposalId,
			status: row.status,
			proposal: { equals: toJson(row.proposal) },
			sourceMetadata: sourceMetadataEquals(row.sourceMetadata),
		},
		data: {
			sourceMetadata: toJson({
				...(asJsonRecord(row.sourceMetadata) ?? {}),
				[REJECTED_CHANGE_INDEXES_KEY]: nextRejected,
			}),
			...(closing ? closedStatus : {}),
		},
	});
	if (updated.count !== 1) {
		throw new ProposalItemMoveConflict();
	}
	return { outcome: "split", splitProposalId: split.id };
}

/**
 * Move one unresolved item of a PENDING or FAILED proposal to Rejected, in
 * one transaction. The original's write is a compare-and-set on the status,
 * the metadata and the proposal read, so a concurrent apply, merge or
 * per-item action rolls the split back and reports `proposal_changed`.
 */
export async function movePendingProposalItemToBacklog(
	params: MoveProposalItemParams,
): Promise<MoveProposalItemResult> {
	try {
		return await db.$transaction((tx) => moveItemInTransaction(tx, params));
	} catch (error) {
		if (error instanceof ProposalItemMoveConflict) {
			return { outcome: "proposal_changed" };
		}
		throw error;
	}
}
