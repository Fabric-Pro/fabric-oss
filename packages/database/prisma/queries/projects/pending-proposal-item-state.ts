/**
 * Per-item state of a PendingBacklogProposal, derived without a schema change.
 *
 * An item (one entry of `proposal.changes[]`) is resolved when it was applied
 * (`appliedChangeIndexes` mirror, an application row, or a duplicate
 * resolution) or moved to Rejected on its own
 * (`sourceMetadata.rejectedChangeIndexes`). A proposal stays in review while
 * any item is unresolved, so an apply that settles only some items returns
 * the row to PENDING instead of closing it.
 */

import { db, Prisma } from "../../client";

/** `sourceMetadata` key listing the items moved to Rejected one at a time. */
export const REJECTED_CHANGE_INDEXES_KEY = "rejectedChangeIndexes";

/**
 * Compare-and-set filter: the row's `sourceMetadata` still equals the value
 * a per-item check read, so a concurrent per-item write fails the CAS.
 */
export function sourceMetadataEquals(value: Prisma.JsonValue | null) {
	if (value === null) {
		return { equals: Prisma.AnyNull };
	}
	const json: Prisma.InputJsonValue = JSON.parse(JSON.stringify(value));
	return { equals: json };
}

function isChangeIndex(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Item indexes a reviewer moved to Rejected one at a time, ascending. */
export function readRejectedChangeIndexes(sourceMetadata: unknown): number[] {
	if (
		!sourceMetadata ||
		typeof sourceMetadata !== "object" ||
		Array.isArray(sourceMetadata)
	) {
		return [];
	}
	const raw = (sourceMetadata as Record<string, unknown>)[
		REJECTED_CHANGE_INDEXES_KEY
	];
	if (!Array.isArray(raw)) {
		return [];
	}
	return Array.from(new Set(raw.filter(isChangeIndex))).sort((a, b) => a - b);
}

/** Why an item no longer waits for a decision. */
export type ProposalItemResolution = "applied" | "duplicate" | "rejected";

export interface ResolvedProposalItem {
	changeIndex: number;
	reason: ProposalItemResolution;
}

export interface ProposalItemState {
	changeCount: number;
	/** Applied or resolved as a duplicate of an existing item. */
	applied: Set<number>;
	rejected: Set<number>;
	/** `applied ∪ rejected`, limited to the proposal's own indexes. */
	resolved: Set<number>;
	/** Every resolved item with its reason, in index order. */
	resolvedItems: ResolvedProposalItem[];
	/** Items still waiting for a decision. */
	remainingCount: number;
}

/** Pure resolved-set rule shared by every apply and per-item path. */
export function computeProposalItemState(params: {
	changeCount: number;
	appliedChangeIndexes: readonly number[];
	applicationIndexes: readonly number[];
	duplicateIndexes: readonly number[];
	rejectedChangeIndexes: readonly number[];
}): ProposalItemState {
	const inRange = (index: number) =>
		Number.isInteger(index) && index >= 0 && index < params.changeCount;
	const duplicates = new Set(params.duplicateIndexes.filter(inRange));
	const applied = new Set(
		[
			...params.appliedChangeIndexes,
			...params.applicationIndexes,
			...duplicates,
		].filter(inRange),
	);
	const rejected = new Set(params.rejectedChangeIndexes.filter(inRange));
	const resolved = new Set([...applied, ...rejected]);
	const reasonOf = (index: number): ProposalItemResolution =>
		duplicates.has(index)
			? "duplicate"
			: applied.has(index)
				? "applied"
				: "rejected";
	return {
		changeCount: params.changeCount,
		applied,
		rejected,
		resolved,
		resolvedItems: [...resolved]
			.sort((a, b) => a - b)
			.map((changeIndex) => ({
				changeIndex,
				reason: reasonOf(changeIndex),
			})),
		remainingCount: Math.max(0, params.changeCount - resolved.size),
	};
}

/** Proposal columns the per-item state is derived from. */
export interface ProposalItemStateRow {
	changeCount: number;
	appliedChangeIndexes: number[];
	sourceMetadata: Prisma.JsonValue | null;
}

/** Load a proposal's per-item state; null when the row does not exist. */
export async function getProposalItemState(
	proposalId: string,
	client: Prisma.TransactionClient = db,
): Promise<ProposalItemState | null> {
	const row = await client.pendingBacklogProposal.findUnique({
		where: { id: proposalId },
		select: {
			changeCount: true,
			appliedChangeIndexes: true,
			sourceMetadata: true,
		},
	});
	return row ? await proposalItemStateForRow(proposalId, row, client) : null;
}

/** Per-item state of a row the caller already read (same client). */
export async function proposalItemStateForRow(
	proposalId: string,
	row: ProposalItemStateRow,
	client: Prisma.TransactionClient = db,
): Promise<ProposalItemState> {
	const [applications, duplicates] = await Promise.all([
		client.pendingBacklogProposalApplication.findMany({
			where: { proposalId },
			select: { changeIndex: true },
		}),
		client.pendingBacklogProposalDuplicateResolution.findMany({
			where: { proposalId },
			select: { changeIndex: true },
		}),
	]);
	return computeProposalItemState({
		changeCount: row.changeCount,
		appliedChangeIndexes: row.appliedChangeIndexes,
		applicationIndexes: applications.map((a) => a.changeIndex),
		duplicateIndexes: duplicates.map((d) => d.changeIndex),
		rejectedChangeIndexes: readRejectedChangeIndexes(row.sourceMetadata),
	});
}

/** Per-change application records, for the inbox's per-item state. */
export async function listProposalApplications(proposalId: string) {
	return await db.pendingBacklogProposalApplication.findMany({
		where: { proposalId },
		select: { changeIndex: true, createdEntityId: true, action: true },
		orderBy: { changeIndex: "asc" },
	});
}

/** Items resolved as duplicates of an existing ticket, with that ticket. */
export async function listProposalDuplicateResolutions(proposalId: string) {
	return await db.pendingBacklogProposalDuplicateResolution.findMany({
		where: { proposalId },
		select: { changeIndex: true, existingEntityId: true },
		orderBy: { changeIndex: "asc" },
	});
}

function indexesByProposal(
	rows: readonly { proposalId: string; changeIndex: number }[],
): Map<string, number[]> {
	const byProposal = new Map<string, number[]>();
	for (const row of rows) {
		byProposal.set(row.proposalId, [
			...(byProposal.get(row.proposalId) ?? []),
			row.changeIndex,
		]);
	}
	return byProposal;
}

/**
 * Per-item state of many rows the caller already read, in the rows' order,
 * from two batched queries rather than two per proposal.
 */
export async function listProposalItemStates(
	rows: readonly (ProposalItemStateRow & { id: string })[],
): Promise<ProposalItemState[]> {
	if (rows.length === 0) {
		return [];
	}
	const proposalIds = rows.map((row) => row.id);
	const [applications, duplicates] = await Promise.all([
		db.pendingBacklogProposalApplication.findMany({
			where: { proposalId: { in: proposalIds } },
			select: { proposalId: true, changeIndex: true },
		}),
		db.pendingBacklogProposalDuplicateResolution.findMany({
			where: { proposalId: { in: proposalIds } },
			select: { proposalId: true, changeIndex: true },
		}),
	]);
	const applicationIndexes = indexesByProposal(applications);
	const duplicateIndexes = indexesByProposal(duplicates);
	return rows.map((row) =>
		computeProposalItemState({
			changeCount: row.changeCount,
			appliedChangeIndexes: row.appliedChangeIndexes,
			applicationIndexes: applicationIndexes.get(row.id) ?? [],
			duplicateIndexes: duplicateIndexes.get(row.id) ?? [],
			rejectedChangeIndexes: readRejectedChangeIndexes(
				row.sourceMetadata,
			),
		}),
	);
}

export interface SettledProposalApply {
	status: "APPLIED" | "PENDING";
	remainingCount: number;
}

/**
 * Settle a proposal after a successful apply: APPLIED when every item is
 * resolved, otherwise back to PENDING with the claim released (workflow id,
 * dispatch clock and error fields cleared) so the remaining items can be
 * reviewed. `where` narrows the write to the caller's claim; returns null
 * when the row is missing or the claim no longer matches.
 */
export async function settleAppliedProposal(params: {
	proposalId: string;
	where?: Prisma.PendingBacklogProposalWhereInput;
}): Promise<SettledProposalApply | null> {
	const state = await getProposalItemState(params.proposalId);
	if (!state) {
		return null;
	}
	const reopen = state.remainingCount > 0;
	const result = await db.pendingBacklogProposal.updateMany({
		where: { id: params.proposalId, ...params.where },
		data: reopen
			? {
					status: "PENDING",
					applyWorkflowId: null,
					applyStartedAt: null,
					applyError: null,
					errorClass: null,
					errorMessage: null,
					failedAt: null,
				}
			: { status: "APPLIED", appliedAt: new Date(), applyError: null },
	});
	if (result.count !== 1) {
		return null;
	}
	return {
		status: reopen ? "PENDING" : "APPLIED",
		remainingCount: state.remainingCount,
	};
}

/** How an apply that needed no workflow left the proposal. */
export interface CreatesOnlyApplySettlement {
	/** `pending`: other items of the proposal are back in review. */
	status: "applied" | "pending";
	remainingChangeCount: number;
}

/**
 * Settle a proposal whose apply finished in the request (creates only, or
 * every item already on the Roadmap), through the shared per-item rule. A
 * row that is gone or no longer matches `where` was settled by someone else
 * and reads as applied.
 */
export async function settleCreatesOnlyApply(params: {
	proposalId: string;
	where?: Prisma.PendingBacklogProposalWhereInput;
}): Promise<CreatesOnlyApplySettlement> {
	const settled = await settleAppliedProposal(params);
	return settled?.status === "PENDING"
		? { status: "pending", remainingChangeCount: settled.remainingCount }
		: { status: "applied", remainingChangeCount: 0 };
}

/**
 * Terminal transition of an apply, written only while the row still carries
 * the caller's claim: APPLYING for a claimed apply, or PENDING for a row an
 * older API dispatched with the same workflow id.
 *
 * A successful apply settles through the per-item rule. A failed apply is
 * recorded with its classified error, except a ROADMAP_RECOMMENDATION batch
 * with undecided items, which returns to review: a retry would replay every
 * unapplied candidate, including those nobody selected.
 *
 * @returns false when the caller no longer holds the claim.
 */
export async function finalizeProposalApply(params: {
	proposalId: string;
	claim: { status: "APPLYING" | "PENDING"; applyWorkflowId: string };
	outcome: "applied" | "failed";
	errorClass?: string;
	errorMessage?: string;
	rawApplyError?: string;
}): Promise<boolean> {
	if (params.outcome === "applied") {
		const settled = await settleAppliedProposal({
			proposalId: params.proposalId,
			where: params.claim,
		});
		return settled !== null;
	}

	const errorMessage = params.errorMessage ?? "apply workflow failed";
	const failure = {
		applyError: (params.rawApplyError ?? errorMessage).slice(0, 4000),
		errorClass: (params.errorClass ?? "default").slice(0, 200),
		errorMessage: errorMessage.slice(0, 500),
		failedAt: new Date(),
	};
	const row = await db.pendingBacklogProposal.findUnique({
		where: { id: params.proposalId },
		select: {
			source: true,
			changeCount: true,
			appliedChangeIndexes: true,
			sourceMetadata: true,
		},
	});
	const state =
		row?.source === "ROADMAP_RECOMMENDATION"
			? await proposalItemStateForRow(params.proposalId, row)
			: null;
	const reopen = (state?.remainingCount ?? 0) > 0;
	const result = await db.pendingBacklogProposal.updateMany({
		where: { id: params.proposalId, ...params.claim },
		data: reopen
			? {
					status: "PENDING",
					applyWorkflowId: null,
					applyStartedAt: null,
					...failure,
				}
			: { status: "FAILED", ...failure },
	});
	return result.count === 1;
}
