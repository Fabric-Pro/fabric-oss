/**
 * Living Memory write folders (ADR-022): the folders of a project's
 * repository sync that agents' files are written into, and how each lands.
 *
 * A target belongs to the project's one sync (`ProjectContextRepositorySync`)
 * and is deleted with it. Every change here runs in one transaction under lock
 * 1 of the sync (`lockContextRepositorySyncByProject`, the configuration row),
 * the lock `configure` and `disable` take first, so a target is never judged
 * against a selection a concurrent `configure` is replacing, and a target is
 * never written for a sync that `disable` is deleting. Nothing here touches
 * run rows, so the lock order (configuration row, then run row) is unchanged.
 * None of this goes through `upsertContextRepositorySync`, which reassigns
 * the sync's `userId` and bumps its `generation`: adding a write folder is no
 * change to what is synced.
 *
 * The rules a target must satisfy live with the API (they reuse its path
 * rules), so each writer takes a `decide` function: handed the sync as it
 * stands under the lock, the other targets and the instruction roots, it says
 * which folder and mode to store or why to refuse. It runs inside the
 * transaction and must be pure.
 *
 * `version` starts at 1 and is bumped by every update, so a write admitted
 * against one version is not mistaken for the next one's. The DIRECT_PUSH
 * record, who enabled it and when, is kept consistent here, in one place:
 * set when a target comes to be DIRECT_PUSH (new, or moved from another mode,
 * or re-pointed at another folder, since the approval was for that folder),
 * cleared when it is not. No other code sets either column.
 *
 * `indexMode` (Index for AI search, or Store only) is the folder's choice
 * about embedding its files. The rows under a folder carry a derived copy of
 * it, recomputed (`reconcileContextIndexing`) in the same transaction as
 * every change here, under the same lock; the writers hand back what that
 * moved (`reindex`) so the caller can delete the vectors of rows that became
 * store-only and index the ones that stopped being.
 */

import { db, type Prisma } from "../../client";
import type {
	ProjectContextIndexMode,
	ProjectContextWriteMode,
} from "../../generated/client";
import {
	type ContextIndexReconcileResult,
	reconcileContextIndexing,
} from "./context-index-mode";
import {
	CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS,
	type LockedContextRepositorySync,
	lockContextRepositorySyncByProject,
} from "./context-repository-sync";

/** How a write folder's files land: derived from the enum, not restated. */
export type ContextWriteMode = ProjectContextWriteMode;

/** Whether a folder's files are embedded for AI search: derived from the enum. */
export type ContextWriteIndexMode = ProjectContextIndexMode;

const targetSelect = {
	id: true,
	syncId: true,
	projectId: true,
	organizationId: true,
	userId: true,
	folder: true,
	mode: true,
	indexMode: true,
	directPushEnabledById: true,
	directPushEnabledAt: true,
	version: true,
	createdAt: true,
	updatedAt: true,
} satisfies Prisma.ProjectContextWriteTargetSelect;

export type ContextWriteTargetView =
	Prisma.ProjectContextWriteTargetGetPayload<{
		select: typeof targetSelect;
	}>;

type TargetScope = { projectId: string; organizationId: string };

/** The part of the locked sync a target is judged against. */
export type ContextWriteTargetSync = Pick<
	LockedContextRepositorySync,
	| "id"
	| "userId"
	| "repositoryIntegrationId"
	| "ref"
	| "paths"
	| "excludedPaths"
>;

/** What `decide` is handed, read under the sync's lock. */
export interface ContextWriteTargetState {
	sync: ContextWriteTargetSync;
	/** Every OTHER target of the sync: all of them, when one is being created. */
	siblings: ContextWriteTargetView[];
	/**
	 * Roots of the project's coding-instructions sync when it reads the same
	 * repository integration (at most one), else none.
	 */
	instructionRoots: string[];
}

export type ContextWriteTargetDecision<Refusal> =
	| {
			accept: true;
			folder: string;
			mode: ContextWriteMode;
			/** Absent: INDEXED for a new folder, the stored choice for an update. */
			indexMode?: ContextWriteIndexMode;
	  }
	| { accept: false; refusal: Refusal };

export type CreateContextWriteTargetResult<Refusal> =
	| { status: "not-configured" }
	| { status: "refused"; refusal: Refusal }
	| {
			status: "created";
			target: ContextWriteTargetView;
			reindex: ContextIndexReconcileResult;
	  };

export type UpdateContextWriteTargetResult<Refusal> =
	| { status: "not-configured" }
	| { status: "not-found" }
	| { status: "refused"; refusal: Refusal }
	| {
			status: "updated";
			target: ContextWriteTargetView;
			previous: {
				folder: string;
				mode: ContextWriteMode;
				indexMode: ContextWriteIndexMode;
			};
			reindex: ContextIndexReconcileResult;
	  };

export type DeleteContextWriteTargetResult =
	| { status: "not-configured" }
	| { status: "not-found" }
	| {
			status: "deleted";
			target: ContextWriteTargetView;
			reindex: ContextIndexReconcileResult;
	  };

/** The sync's write folders, by folder. The project has at most one sync. */
export function listContextWriteTargets(
	scope: TargetScope,
): Promise<ContextWriteTargetView[]> {
	return db.projectContextWriteTarget.findMany({
		where: {
			projectId: scope.projectId,
			organizationId: scope.organizationId,
		},
		orderBy: { folder: "asc" },
		select: targetSelect,
	});
}

async function loadState(
	tx: Prisma.TransactionClient,
	sync: LockedContextRepositorySync,
	targetId: string | null,
): Promise<{
	target: ContextWriteTargetView | null;
	state: ContextWriteTargetState;
}> {
	const [targets, instructionSyncs] = await Promise.all([
		tx.projectContextWriteTarget.findMany({
			where: { syncId: sync.id },
			orderBy: { folder: "asc" },
			select: targetSelect,
		}),
		tx.projectInstructionRepositorySync.findMany({
			where: {
				projectId: sync.projectId,
				repositoryIntegrationId: sync.repositoryIntegrationId,
			},
			select: { rootPath: true },
		}),
	]);
	return {
		target: targets.find((target) => target.id === targetId) ?? null,
		state: {
			sync,
			siblings: targets.filter((target) => target.id !== targetId),
			instructionRoots: instructionSyncs.map((row) => row.rootPath),
		},
	};
}

/**
 * Add a write folder to the project's sync. `decide` sees the sync, its other
 * targets and the instruction roots, and picks the stored folder and mode or
 * refuses. A DIRECT_PUSH target is recorded as enabled by `userId`, now.
 */
export function createContextWriteTarget<Refusal>(
	input: TargetScope & { userId: string },
	decide: (
		state: ContextWriteTargetState,
	) => ContextWriteTargetDecision<Refusal>,
): Promise<CreateContextWriteTargetResult<Refusal>> {
	return db.$transaction(
		async (tx): Promise<CreateContextWriteTargetResult<Refusal>> => {
			const sync = await lockContextRepositorySyncByProject(tx, input);
			if (!sync) {
				return { status: "not-configured" };
			}
			const { state } = await loadState(tx, sync, null);
			const decision = decide(state);
			if (!decision.accept) {
				return { status: "refused", refusal: decision.refusal };
			}
			const directPush = decision.mode === "DIRECT_PUSH";
			const target = await tx.projectContextWriteTarget.create({
				data: {
					syncId: sync.id,
					projectId: input.projectId,
					organizationId: input.organizationId,
					userId: input.userId,
					folder: decision.folder,
					mode: decision.mode,
					indexMode: decision.indexMode ?? "INDEXED",
					directPushEnabledById: directPush ? input.userId : null,
					directPushEnabledAt: directPush ? sync.now : null,
				},
				select: targetSelect,
			});
			const reindex = await reconcileContextIndexing(tx, {
				projectId: input.projectId,
				organizationId: input.organizationId,
				syncId: sync.id,
				actingUserId: sync.userId,
			});
			return { status: "created", target, reindex };
		},
		{ timeout: CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS },
	);
}

/**
 * Change a write folder's folder or mode and bump its `version`. `decide`
 * sees the target as stored now, so a check made on its result (such as who
 * may turn DIRECT_PUSH on) is made against what is really there, not what the
 * request read earlier. `userId` becomes the member who last edited it.
 */
export function updateContextWriteTarget<Refusal>(
	input: TargetScope & { userId: string; targetId: string },
	decide: (
		state: ContextWriteTargetState,
		current: ContextWriteTargetView,
	) => ContextWriteTargetDecision<Refusal>,
): Promise<UpdateContextWriteTargetResult<Refusal>> {
	return db.$transaction(
		async (tx): Promise<UpdateContextWriteTargetResult<Refusal>> => {
			const sync = await lockContextRepositorySyncByProject(tx, input);
			if (!sync) {
				return { status: "not-configured" };
			}
			const { target: existing, state } = await loadState(
				tx,
				sync,
				input.targetId,
			);
			if (!existing) {
				return { status: "not-found" };
			}
			const decision = decide(state, existing);
			if (!decision.accept) {
				return { status: "refused", refusal: decision.refusal };
			}
			const directPush = decision.mode === "DIRECT_PUSH";
			const keepsApproval =
				directPush &&
				existing.mode === "DIRECT_PUSH" &&
				existing.folder === decision.folder;
			const target = await tx.projectContextWriteTarget.update({
				where: { id: existing.id },
				data: {
					userId: input.userId,
					folder: decision.folder,
					mode: decision.mode,
					indexMode: decision.indexMode ?? existing.indexMode,
					version: { increment: 1 },
					...(keepsApproval
						? {}
						: {
								directPushEnabledById: directPush
									? input.userId
									: null,
								directPushEnabledAt: directPush
									? sync.now
									: null,
							}),
				},
				select: targetSelect,
			});
			const reindex = await reconcileContextIndexing(tx, {
				projectId: input.projectId,
				organizationId: input.organizationId,
				syncId: sync.id,
				actingUserId: sync.userId,
			});
			return {
				status: "updated",
				target,
				previous: {
					folder: existing.folder,
					mode: existing.mode,
					indexMode: existing.indexMode,
				},
				reindex,
			};
		},
		{ timeout: CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS },
	);
}

/**
 * Remove a write folder. Receipts of writes already admitted through it stay:
 * they carry no foreign key to it.
 */
export function deleteContextWriteTarget(
	input: TargetScope & { targetId: string },
): Promise<DeleteContextWriteTargetResult> {
	return db.$transaction(
		async (tx): Promise<DeleteContextWriteTargetResult> => {
			const sync = await lockContextRepositorySyncByProject(tx, input);
			if (!sync) {
				return { status: "not-configured" };
			}
			const target = await tx.projectContextWriteTarget.findFirst({
				where: { id: input.targetId, syncId: sync.id },
				select: targetSelect,
			});
			if (!target) {
				return { status: "not-found" };
			}
			await tx.projectContextWriteTarget.delete({
				where: { id: target.id },
			});
			const reindex = await reconcileContextIndexing(tx, {
				projectId: input.projectId,
				organizationId: input.organizationId,
				syncId: sync.id,
				actingUserId: sync.userId,
			});
			return { status: "deleted", target, reindex };
		},
		{ timeout: CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS },
	);
}
