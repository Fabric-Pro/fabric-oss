/**
 * The database half of a direct commit to a repository-backed project's
 * synced branch (Fizzy #2878 §10).
 *
 * A direct commit is a `REPOSITORY_COMMIT` snapshot: it is derived, validated
 * and scanned like any other (`createDerivedInstructionSnapshot` with
 * `commit`), and stops at READY without publishing. The commit workflow then
 * reads the row here, pushes one commit to the branch named by its frozen
 * `commitContext`, and settles it exactly once through one of three writes:
 *
 * - `recordDirectCommitPushed`: the branch holds the commit. The outcome and
 *   the audit row commit together. The snapshot itself stays what it was, a
 *   derived row that is never published: it holds the change stated against
 *   the base, while the branch tip the commit landed on may carry teammates'
 *   changes it knows nothing of, so publishing it would put a stale copy in
 *   front of every agent. The published version comes from the sync the
 *   commit then triggers, which reads the real tree.
 * - `admitDirectCommitAsProposal`: the branch refused the push or kept moving,
 *   so the SAME rows become a member branch proposal (`REPOSITORY`,
 *   `QUEUED`, v2 context) for the existing branch machinery to open as a pull
 *   request. Nothing is re-validated: the rows already passed the scan.
 * - `recordDirectCommitOutcome`: anything else (`unchanged`, `branch-moved`,
 *   `failed`), written only while no outcome is recorded.
 *
 * Every write is fenced on `commitOutcome IS NULL` and the destination, so a
 * retried activity or two overlapping attempts settle the row once.
 */
import { db, Prisma } from "../client";
import { recordAuditTx } from "./audit-log";

/** The row the commit workflow acts on. Tenant-scoped on every read. */
export function getDirectCommitSnapshot(input: {
	snapshotId: string;
	organizationId: string;
}) {
	return db.projectInstructionSnapshot.findFirst({
		where: { id: input.snapshotId, organizationId: input.organizationId },
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			userId: true,
			version: true,
			status: true,
			contentKind: true,
			source: true,
			proposalDestination: true,
			proposalStatus: true,
			commitContext: true,
			commitOutcome: true,
			baseSnapshotId: true,
			fileCount: true,
			publishedAt: true,
			createdAt: true,
		},
	});
}

export type DirectCommitSnapshotRow = NonNullable<
	Awaited<ReturnType<typeof getDirectCommitSnapshot>>
>;

/**
 * How long a direct commit with no outcome counts as pending for the purpose
 * of keeping a revert out of its way, and of being returned to a retried
 * request as the commit it duplicates. The commit workflow records
 * `VALIDATION_TIMEOUT` after thirty minutes of waiting for the scan and then
 * pushes within minutes, and a retried request arrives within minutes of the
 * lost response, so a row older than this has no workflow behind it and must
 * neither block reverts for good nor stand in for a commit someone asks for
 * again.
 */
export const PENDING_COMMIT_WINDOW_MS = 2 * 60 * 60_000;

/**
 * How long a direct commit with no outcome counts against the member's and
 * the project's caps, and how long the reaper waits before it closes one that
 * is still READY with no outcome as `failed STALE`. The workflows are started
 * with a 24 hour execution timeout (`COMMIT_WORKFLOW_EXECUTION_TIMEOUT_MS` in
 * `@repo/temporal`), so a pending row older than this has nothing behind it:
 * without the bound five of them lock a member out of committing for good,
 * and twenty-five lock out the project.
 */
export const STALE_COMMIT_AFTER_MS = 24 * 60 * 60_000;

/**
 * Whether the project has a direct commit that is still on its way to the
 * branch: no outcome yet, not refused by the scan, and recent. A revert and a
 * commit write the same branch tip, so a revert is refused while one is
 * pending instead of racing it.
 */
export async function hasPendingDirectCommit(input: {
	projectId: string;
	organizationId: string;
}): Promise<boolean> {
	const pending = await db.projectInstructionSnapshot.count({
		where: {
			projectId: input.projectId,
			organizationId: input.organizationId,
			proposalDestination: "REPOSITORY_COMMIT",
			commitOutcome: { equals: Prisma.DbNull },
			status: { not: "REJECTED" },
			createdAt: { gt: new Date(Date.now() - PENDING_COMMIT_WINDOW_MS) },
		},
	});
	return pending > 0;
}

/** The fence every settling write carries: still a pending direct commit that is READY. */
function pendingCommitWhere(input: {
	snapshotId: string;
	organizationId: string;
}) {
	return {
		id: input.snapshotId,
		organizationId: input.organizationId,
		proposalDestination: "REPOSITORY_COMMIT" as const,
		status: "READY" as const,
		commitOutcome: { equals: Prisma.DbNull },
	};
}

/**
 * Records an outcome that needs nothing else written (`unchanged`,
 * `branch-moved`, `failed`). False when the row is not a pending direct
 * commit any more: an earlier attempt already settled it.
 */
export async function recordDirectCommitOutcome(input: {
	snapshotId: string;
	organizationId: string;
	outcome: Prisma.InputJsonValue;
}): Promise<boolean> {
	const { count } = await db.projectInstructionSnapshot.updateMany({
		where: pendingCommitWhere(input),
		data: { commitOutcome: input.outcome },
	});
	return count === 1;
}

/**
 * Direct commits that reached READY and have had no outcome for longer than
 * `cutoff`, oldest first: pending ones that no workflow stands behind any more
 * (it ran out its execution timeout, was terminated, or its record gave up and
 * its report could not be written). One page at `offset`, and the size of the
 * whole population, in one total order, for the reaper's rotation.
 *
 * SYSTEM-WIDE, with no tenant in scope, like the reaper's other candidate
 * queries: it hands the caller each row's own `projectId` and
 * `organizationId`, and the write that follows is bound to them.
 */
export async function listStaleDirectCommits(
	cutoff: Date,
	limit: number,
	offset: number,
): Promise<{
	candidates: Array<{
		id: string;
		projectId: string;
		organizationId: string;
		createdAt: Date;
	}>;
	total: number;
}> {
	const where = {
		proposalDestination: "REPOSITORY_COMMIT" as const,
		status: "READY" as const,
		commitOutcome: { equals: Prisma.DbNull },
		createdAt: { lt: cutoff },
	} satisfies Prisma.ProjectInstructionSnapshotWhereInput;
	const [candidates, total] = await Promise.all([
		db.projectInstructionSnapshot.findMany({
			where,
			orderBy: [{ createdAt: "asc" }, { id: "asc" }],
			skip: offset,
			take: limit,
			select: {
				id: true,
				projectId: true,
				organizationId: true,
				createdAt: true,
			},
		}),
		db.projectInstructionSnapshot.count({ where }),
	]);
	return { candidates, total };
}

/**
 * Closes a stale pending direct commit out as `failed STALE`, retryable (the
 * change was never written to the branch). Fenced as every settling write is
 * (still a READY direct commit with no outcome, in this tenant) and on its age
 * (older than `cutoff`), so a commit that settled since the reaper listed it,
 * or one that is younger than the list implied, is left alone. True when this
 * call closed it.
 */
export async function failStaleDirectCommit(input: {
	snapshotId: string;
	organizationId: string;
	cutoff: Date;
}): Promise<boolean> {
	const { count } = await db.projectInstructionSnapshot.updateMany({
		where: {
			...pendingCommitWhere(input),
			createdAt: { lt: input.cutoff },
		},
		data: {
			commitOutcome: {
				outcome: "failed",
				code: "STALE",
				retryable: true,
			},
		},
	});
	return count === 1;
}

/**
 * A failure recorded against a snapshot that never got to READY (the commit
 * workflow stopped waiting for validation): the one outcome that may be
 * written to a row whose status is not READY. Still written once.
 */
export async function recordDirectCommitFailureBeforeReady(input: {
	snapshotId: string;
	organizationId: string;
	outcome: Prisma.InputJsonValue;
}): Promise<boolean> {
	const { count } = await db.projectInstructionSnapshot.updateMany({
		where: {
			id: input.snapshotId,
			organizationId: input.organizationId,
			proposalDestination: "REPOSITORY_COMMIT",
			status: { not: "READY" },
			commitOutcome: { equals: Prisma.DbNull },
		},
		data: { commitOutcome: input.outcome },
	});
	return count === 1;
}

/**
 * The branch holds the commit: `committed` is recorded as the outcome and the
 * `project.instructions.committed` audit row commits with it. The snapshot is
 * not stamped as a copy of `sha` and not published (see the module comment).
 * Counts and the commit id only, never a path, a message or file content.
 */
export async function recordDirectCommitPushed(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	actorUserId: string;
	ref: string;
	sha: string;
	fileCount: number;
}): Promise<boolean> {
	return db.$transaction(async (tx) => {
		const { count } = await tx.projectInstructionSnapshot.updateMany({
			where: pendingCommitWhere(input),
			data: {
				commitOutcome: {
					outcome: "committed",
					sha: input.sha,
					ref: input.ref,
				},
			},
		});
		if (count !== 1) {
			return false;
		}
		await recordAuditTx(tx, {
			action: "project.instructions.committed",
			category: "project",
			actor: { type: "user", userId: input.actorUserId },
			organizationId: input.organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_instruction_snapshot",
				id: input.snapshotId,
			},
			metadata: {
				sha: input.sha,
				ref: input.ref,
				fileCount: input.fileCount,
			},
		});
		return true;
	});
}

/**
 * A revert's commit is on the branch: the `project.instructions.committed`
 * audit row, written in its own transaction and awaited (a revert has no
 * snapshot row to settle). Skips a commit it recorded already, so the
 * activity that calls it can be retried freely. Counts and ids only.
 */
export async function recordRevertCommitted(input: {
	projectId: string;
	organizationId: string;
	actorUserId: string;
	sha: string;
	ref: string;
	fileCount: number;
	revertOf: string;
}): Promise<void> {
	await db.$transaction(async (tx) => {
		const recorded = await tx.auditLog.count({
			where: {
				organizationId: input.organizationId,
				action: "project.instructions.committed",
				resourceType: "project_instruction_commit",
				resourceId: input.sha,
			},
		});
		if (recorded > 0) {
			return;
		}
		await recordAuditTx(tx, {
			action: "project.instructions.committed",
			category: "project",
			outcome: "success",
			actor: { type: "user", userId: input.actorUserId },
			organizationId: input.organizationId,
			projectId: input.projectId,
			resource: { type: "project_instruction_commit", id: input.sha },
			metadata: {
				sha: input.sha,
				ref: input.ref,
				fileCount: input.fileCount,
				revertOf: input.revertOf,
			},
		});
	});
}

/** The next member-wide intent order (spec Decision 8): a database sequence. */
async function nextIntentOrder(tx: Prisma.TransactionClient): Promise<bigint> {
	const [row] = await tx.$queryRaw<Array<{ v: bigint | number | string }>>`
		SELECT nextval('project_instruction_proposal_intent_seq') AS "v"`;
	if (row === undefined) {
		throw new Error("The proposal intent sequence returned no value");
	}
	return BigInt(row.v);
}

/**
 * The branch refused the push (`protected`) or kept moving under three
 * attempts (`busy`): the same snapshot rows are admitted as a REPOSITORY
 * proposal on the member's branch, QUEUED with the frozen v2 context, for the
 * existing join and branch workflow to open as a pull request.
 *
 * Not subject to the proposal caps: the member asked to commit, and nothing
 * but the refusal made this a proposal. The proposal's `userId` is the
 * committer's, as any proposal's is.
 */
export async function admitDirectCommitAsProposal(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	actorUserId: string;
	operationId: string;
	/** `pullRequestContextSchemaV2`-valid. */
	context: Prisma.InputJsonValue;
	reason: "protected" | "busy";
}): Promise<boolean> {
	return db.$transaction(async (tx) => {
		const intentOrder = await nextIntentOrder(tx);
		const { count } = await tx.projectInstructionSnapshot.updateMany({
			where: pendingCommitWhere(input),
			data: {
				proposalDestination: "REPOSITORY",
				proposalStatus: "PENDING",
				pullRequestOperationId: input.operationId,
				pullRequestContext: input.context,
				pullRequestState: "QUEUED",
				proposalIntentOrder: intentOrder,
				commitOutcome: {
					outcome: "pull-request",
					operationId: input.operationId,
					reason: input.reason,
				},
			},
		});
		if (count !== 1) {
			return false;
		}
		await recordAuditTx(tx, {
			action: "project.instructions.commit_fell_back_to_pull_request",
			category: "project",
			actor: { type: "user", userId: input.actorUserId },
			organizationId: input.organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_instruction_snapshot",
				id: input.snapshotId,
			},
			metadata: { reason: input.reason, operationId: input.operationId },
		});
		return true;
	});
}
