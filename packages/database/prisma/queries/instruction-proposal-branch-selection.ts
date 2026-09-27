/**
 * The sweeper's member proposal branch sub-batches (Fizzy #2738 spec §8).
 *
 * The five #2563 sub-batches keep their order and limits; each takes branch
 * rows too, and Restart is followed by Attach. `untracked` branches are
 * never selected. Every due test reads the database clock (#2563 Review
 * Focus 4), with `AT TIME ZONE 'UTC'` because the timestamp columns hold
 * UTC without a zone.
 *
 * SYSTEM-WIDE by design, like `selectDueProposalOperations`: it returns ids
 * and each row's own tenant columns, and every action on an item runs under
 * that item's organization and fences on what it reads itself.
 */
import { db, Prisma } from "../client";
import { readBranchWork } from "./instruction-proposal-branches";
import { observeDue } from "./instruction-proposal-pull-requests";

/** One branch a sub-batch selected: ids, the attempt read at selection, the integration. */
export type DueBranch = {
	branchId: string;
	projectId: string;
	organizationId: string;
	attempt: number;
	integrationId: string | null;
};

/** One v2 proposal Attach selected: joined, then its branch woken. */
export type DueAttach = {
	snapshotId: string;
	projectId: string;
	organizationId: string;
};

export type DueBranches = {
	close: DueBranch[];
	recover: DueBranch[];
	mergeSync: DueBranch[];
	observe: DueBranch[];
	restart: DueBranch[];
	attach: DueAttach[];
};

/** Restart reads this many candidates per slot before `readBranchWork` confirms them. */
const RESTART_CANDIDATES_PER_SLOT = 3;

type DueBranchRow = Omit<DueBranch, "attempt"> & { attempt: number | bigint };

function toDueBranches(rows: DueBranchRow[]): DueBranch[] {
	return rows.map((r) => ({
		branchId: r.branchId,
		projectId: r.projectId,
		organizationId: r.organizationId,
		attempt: Number(r.attempt),
		integrationId: r.integrationId,
	}));
}

/** The SQL fragments the branch sub-batches share, built on first use. */
function branchFragments() {
	const nowUtc = Prisma.sql`(now() AT TIME ZONE 'UTC')`;
	const due = Prisma.sql`(b."nextAttemptAt" IS NULL OR b."nextAttemptAt" <= ${nowUtc})`;
	const terminal = Prisma.sql`b."state" IN ('MERGED', 'CLOSED', 'CANCELED')`;
	// §4.4 "Release": BLOCKED on a non-retryable pre-create refusal, with a
	// head, no receipt and no marker (`isReleasableBranch`).
	const releaseRow = Prisma.sql`(b."state" = 'BLOCKED' AND (b."failure"->>'retryable') = 'false' AND (b."failure"->>'code') IN ('PERMISSION_REVOKED', 'CONFIGURATION_CHANGED') AND b."headSha" IS NOT NULL AND b."pullRequestExternalId" IS NULL AND b."createIssuedAt" IS NULL)`;
	const proposalDue = Prisma.sql`(s."pullRequestNextAttemptAt" IS NULL OR s."pullRequestNextAttemptAt" <= ${nowUtc})`;
	const onBranch = Prisma.sql`s."proposalBranchId" = b."id" AND s."organizationId" = b."organizationId"`;
	return {
		nowUtc,
		due,
		releaseRow,
		// Recover: an issued operation with no outcome.
		issuedOperation: Prisma.sql`EXISTS (SELECT 1 FROM "project_instruction_proposal_branch_operation" o WHERE o."branchId" = b."id" AND o."organizationId" = b."organizationId" AND o."outcome" IS NULL)`,
		// Recover: a create marker without a receipt whose lookup is due.
		markerDue: Prisma.sql`(NOT ${terminal} AND b."createIssuedAt" IS NOT NULL AND b."pullRequestExternalId" IS NULL AND b."settledAt" IS NULL AND ${due})`,
		retryRequested: Prisma.sql`(b."state" = 'BLOCKED' AND b."retryRequestedAt" IS NOT NULL)`,
		// Recover: membership pending, once its own backoff is due. The JSON
		// time is an ISO instant, so it compares with `now()` itself.
		membershipPending: Prisma.sql`(b."membership"->>'status' = 'pending' AND (b."membership"->>'nextAttemptAt' IS NULL OR (b."membership"->>'nextAttemptAt')::timestamptz <= now()))`,
		// Restart's candidates, which `readBranchWork` then confirms: the
		// items no earlier sub-batch wakes for (rehome, revert, create,
		// append, wait).
		restartCandidate: Prisma.sql`(
			(b."state" IN ('PENDING', 'OPENING', 'OPEN', 'BLOCKED') AND b."retiredAt" IS NULL
				AND COALESCE(b."failure"->>'code', '') NOT IN ('ATTRIBUTION_REJECTED', 'REPOSITORY_CHANGED')
				AND EXISTS (SELECT 1 FROM "project_instruction_snapshot" s WHERE ${onBranch}
					AND (s."pullRequestState" IN ('QUEUED', 'OPENING')
						OR (s."pullRequestState" = 'BLOCKED' AND (s."pullRequestFailure"->>'retryable') = 'true'
							AND (s."pullRequestFailure"->>'phase') IN ('append', 'validation') AND ${proposalDue}))))
			OR (NOT ${terminal} AND EXISTS (SELECT 1 FROM "project_instruction_snapshot" s WHERE ${onBranch}
				AND s."pullRequestState" = 'CLOSE_REQUESTED' AND ${proposalDue}))
			OR (b."headSha" IS NOT NULL AND b."pullRequestExternalId" IS NULL AND b."createIssuedAt" IS NULL
				AND (b."state" = 'OPENING' OR (b."state" = 'BLOCKED' AND (b."failure"->>'retryable') = 'true' AND (b."failure"->>'phase') = 'create'))
				AND ${due})
			OR ((${terminal} OR b."retiredAt" IS NOT NULL OR (b."closeIntent" = 'START_OVER' AND b."deletedAt" IS NOT NULL))
				AND EXISTS (SELECT 1 FROM "project_instruction_snapshot" s WHERE ${onBranch}
					AND s."withdrawRequestedAt" IS NULL
					AND s."pullRequestState" IN ('QUEUED', 'OPENING', 'OPEN', 'BLOCKED')))
		)`,
		columns: Prisma.sql`b."id" AS "branchId", b."projectId", b."organizationId", b."attempt", b."destination"->>'integrationId' AS "integrationId"`,
	};
}

/**
 * The branch sub-batches of spec §8, in the table's order, as statements in
 * one repeatable-read transaction; a branch an earlier sub-batch took is
 * excluded from every later one. Restart's candidates are then confirmed
 * one by one with `readBranchWork` (not `idle`), outside that transaction.
 *
 * | Sub-batch | Branch rows |
 * |---|---|
 * | Close | CLOSE_REQUESTED (due); a confirmation due; the §4.4 release row (due) |
 * | Recover | an issued operation without outcome; a marker whose lookup is due; `retryRequestedAt`; membership pending (due) |
 * | Merge sync | `mergeSyncRequestedAt` on a MERGED branch (due) |
 * | Observe | OPEN, checked over 10 min ago (due) |
 * | Restart | `nextBranchWork` not idle |
 * | Attach | v2 proposals without a branch, QUEUED, over 2 min old |
 */
export async function selectDueBranches(limits: {
	close: number;
	recover: number;
	mergeSync: number;
	observe: number;
	restart: number;
	attach: number;
}): Promise<DueBranches> {
	const f = branchFragments();
	const selected = await db.$transaction(
		async (tx) => {
			const taken: string[] = [];
			const run = async (
				statement: (excluded: string[]) => Prisma.Sql,
			): Promise<DueBranch[]> => {
				const items = toDueBranches(
					await tx.$queryRaw<DueBranchRow[]>(statement([...taken])),
				);
				taken.push(...items.map((item) => item.branchId));
				return items;
			};
			const from = (excluded: string[]) =>
				Prisma.sql`FROM "project_instruction_proposal_branch" b WHERE NOT b."untracked" AND b."id" <> ALL(${excluded}::text[])`;
			const byNextAttempt = Prisma.sql`ORDER BY b."nextAttemptAt" ASC NULLS FIRST, b."id" ASC`;

			const close = await run(
				(
					excluded,
				) => Prisma.sql`/* branch_sweep:close */ SELECT ${f.columns} ${from(excluded)}
					AND ((b."state" = 'CLOSE_REQUESTED' AND ${f.due}) OR b."confirmationDueAt" <= ${f.nowUtc} OR (${f.releaseRow} AND ${f.due}))
					${byNextAttempt} LIMIT ${limits.close}`,
			);
			const recover = await run(
				(
					excluded,
				) => Prisma.sql`/* branch_sweep:recover */ SELECT ${f.columns} ${from(excluded)}
					AND (${f.issuedOperation} OR ${f.markerDue} OR ${f.retryRequested} OR ${f.membershipPending})
					${byNextAttempt} LIMIT ${limits.recover}`,
			);
			const mergeSync = await run(
				(
					excluded,
				) => Prisma.sql`/* branch_sweep:merge_sync */ SELECT ${f.columns} ${from(excluded)}
					AND b."state" = 'MERGED' AND b."mergeSyncRequestedAt" IS NOT NULL AND ${f.due}
					${byNextAttempt} LIMIT ${limits.mergeSync}`,
			);
			const observe = await run(
				(
					excluded,
				) => Prisma.sql`/* branch_sweep:observe */ SELECT ${f.columns} ${from(excluded)}
					AND b."state" = 'OPEN'
					AND ${observeDue(Prisma.sql`b."lastCheckedAt"`, f.nowUtc)}
					AND ${f.due}
					ORDER BY b."lastCheckedAt" ASC NULLS FIRST, b."id" ASC LIMIT ${limits.observe}`,
			);
			const candidates = toDueBranches(
				await tx.$queryRaw<DueBranchRow[]>(
					Prisma.sql`/* branch_sweep:restart */ SELECT ${f.columns} ${from([...taken])}
						AND ${f.restartCandidate}
						AND b."updatedAt" <= ${f.nowUtc} - interval '2 minutes'
						ORDER BY b."updatedAt" ASC, b."id" ASC LIMIT ${limits.restart * RESTART_CANDIDATES_PER_SLOT}`,
				),
			);
			const attach = (
				await tx.$queryRaw<DueAttach[]>(
					Prisma.sql`/* branch_sweep:attach */ SELECT s."id" AS "snapshotId", s."projectId", s."organizationId"
						FROM "project_instruction_snapshot" s
						WHERE s."proposalDestination" = 'REPOSITORY' AND s."proposalBranchId" IS NULL
							AND (s."pullRequestContext"->>'v') = '2' AND s."pullRequestState" = 'QUEUED'
							AND s."createdAt" <= ${f.nowUtc} - interval '2 minutes'
						ORDER BY s."createdAt" ASC, s."id" ASC LIMIT ${limits.attach}`,
				)
			).map((r) => ({
				snapshotId: r.snapshotId,
				projectId: r.projectId,
				organizationId: r.organizationId,
			}));
			return { close, recover, mergeSync, observe, candidates, attach };
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
	);
	const restart: DueBranch[] = [];
	for (const candidate of selected.candidates) {
		if (restart.length >= limits.restart) {
			break;
		}
		const { work } = await readBranchWork({
			branchId: candidate.branchId,
			organizationId: candidate.organizationId,
		});
		if (work.kind !== "idle") {
			restart.push(candidate);
		}
	}
	return {
		close: selected.close,
		recover: selected.recover,
		mergeSync: selected.mergeSync,
		observe: selected.observe,
		restart,
		attach: selected.attach,
	};
}
