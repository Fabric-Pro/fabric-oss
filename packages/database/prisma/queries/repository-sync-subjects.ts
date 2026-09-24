/**
 * Repository sync subjects, the database half (Decision 46).
 *
 * A subject is one kind of project content that syncs from a repository.
 * The automatic machinery (the poll and the GitHub push webhook) reaches a
 * subject's table only through its store here, and its workflow only through
 * the Temporal half (packages/temporal/src/activities/lib/
 * repository-sync-subjects.ts), which adds `startRun`. This PR registers
 * exactly one subject, `instructions`.
 *
 * The column contract a subject's table carries, with PR 1's meanings:
 * `automatic`, `nextCheckAt`, `failureCount`, `automaticPausedReason`,
 * `automaticPausedAt`, `suppressedCommitSha`, `suppressedGeneration`,
 * `lastEvaluatedCommitSha`, `lastEvaluatedGeneration` and `generation`.
 * `computeSchedulingPatch` writes only these, and a store's fence compares
 * `generation`, `nextCheckAt`, `automatic` and `automaticPausedReason`.
 * `pendingCommitSha` backs `recordPendingHead` and `settlePendingHead`
 * (Fizzy #2682): a re-check request written outside the fence and applied
 * by the subject's own run completion, or by the settle when that run has
 * already finished.
 */
import type { Prisma } from "../client";
import {
	claimDueInstructionSyncRows,
	findInstructionSyncsForPush,
	type InstructionSyncPause,
	instructionSyncLeaseHeld,
	type RepositorySyncSchedulingPatch,
	recordInstructionSyncCheckFailure,
	recordPendingInstructionSyncHead,
	settlePendingInstructionSyncHead,
	writeBackInstructionSync,
} from "./instruction-repository-sync";
import { canCreateProjectInstructions } from "./projects/projects";

export type RepositorySyncSubjectKind = "instructions";

/** One claimed row, in the shape every subject returns (spec §6.1). */
export type ClaimedRepositorySyncRow = {
	id: string;
	projectId: string;
	organizationId: string;
	/** The delegate: the permission check, token resolution and any receipt act as this member. */
	userId: string;
	generation: number;
	repositoryIntegrationId: string;
	ref: string;
	lastEvaluatedCommitSha: string | null;
	lastEvaluatedGeneration: number | null;
	suppressedCommitSha: string | null;
	suppressedGeneration: number | null;
	failureCount: number;
	/** The `nextCheckAt` the claim wrote: the lease every later write compares (Decision 31). */
	leaseUntil: Date;
};

/** What a fenced read or write compares (Decision 31). */
export type RepositorySyncFence = Pick<
	ClaimedRepositorySyncRow,
	"id" | "generation" | "leaseUntil"
>;

/** One sync the push webhook decides on (spec §6.2). */
export type RepositorySyncPushRow = {
	id: string;
	projectId: string;
	organizationId: string;
	generation: number;
	ref: string;
	automatic: boolean;
	automaticPausedReason: string | null;
	lastEvaluatedCommitSha: string | null;
	lastEvaluatedGeneration: number | null;
	suppressedCommitSha: string | null;
	suppressedGeneration: number | null;
};

/** The configuration a pending head is recorded against: the row's identity and tenant. */
export type RepositorySyncPendingHeadRow = Pick<
	RepositorySyncPushRow,
	"id" | "projectId" | "organizationId" | "generation"
>;

/** A client that opens an interactive transaction: `db`, or a test's stand-in. */
export type RepositorySyncTransactionRunner = {
	$transaction<T>(
		fn: (tx: Prisma.TransactionClient) => Promise<T>,
	): Promise<T>;
};

/**
 * What settling a re-check request found (Fizzy #2682), under the sync-row
 * lock:
 * - `consumer_pending`: the open run's receipt is unfinished or not yet
 *   inserted, so its completion takes the same lock later and consumes the
 *   marker. Nothing written.
 * - `made_due`: the run's receipt is already finished, so no completion is
 *   left to read the marker. The settle applied it (due now, or no check at
 *   all on a paused row) and cleared it, or found it already consumed.
 * - `stale`: the row was re-configured or removed since the marker write;
 *   the re-configure made it due now. Nothing written.
 */
export type RepositorySyncPendingHeadSettlement =
	| "consumer_pending"
	| "made_due"
	| "stale";

/** A poll check's terminal receipt (Decisions 33 and 35). */
export type RepositorySyncCheckFailure = {
	row: ClaimedRepositorySyncRow;
	pollRunId: string;
	error: "REF_MISSING" | "PERMISSION_DENIED";
	pause: InstructionSyncPause;
	now?: Date;
};

export interface RepositorySyncSubjectStore {
	readonly kind: RepositorySyncSubjectKind;
	/**
	 * Leases up to `limit` due rows for `leaseMs`, oldest due first.
	 * Cross-tenant. Due and lease are both read from the database's clock,
	 * the clock the fence judges the lease by, so the caller passes a
	 * duration and never a date (Fizzy #2683).
	 */
	listDueAndClaim(
		tx: Prisma.TransactionClient,
		input: { limit: number; leaseMs: number },
	): Promise<ClaimedRepositorySyncRow[]>;
	/**
	 * Whether a row still matches the fence, and the database's clock read
	 * in the same statement, which the check calibrates its own clock from
	 * (Fizzy #2683).
	 */
	leaseHeld(
		tx: Prisma.TransactionClient,
		fence: RepositorySyncFence,
	): Promise<{ held: boolean; dbNow: Date }>;
	/** Applies `patch` only while the row matches the fence. */
	writeBack(
		tx: Prisma.TransactionClient,
		fence: RepositorySyncFence,
		patch: RepositorySyncSchedulingPatch,
	): Promise<{ applied: boolean }>;
	/** The fenced pause, the FAILED POLL run row and its audit; call it inside a transaction. */
	recordCheckFailure(
		tx: Prisma.TransactionClient,
		input: RepositorySyncCheckFailure,
	): Promise<{ applied: boolean }>;
	/**
	 * Asks the open run's completion for a re-check, when a push or a poll
	 * check found a run already open (Fizzy #2682). `commitSha` is kept for
	 * diagnostics only. Fenced on the row's generation and tenant, not on a
	 * lease, and never moves `nextCheckAt`. The caller settles it next.
	 */
	recordPendingHead(
		tx: Prisma.TransactionClient,
		row: RepositorySyncPendingHeadRow,
		commitSha: string,
	): Promise<{ applied: boolean }>;
	/**
	 * Right after `recordPendingHead` applied: checks, under the sync-row
	 * lock, whether the open run `runId` (from the `already_running` answer)
	 * has already finished its receipt, and applies the marker itself when
	 * it has (Fizzy #2682). One transaction of its own.
	 */
	settlePendingHead(
		client: RepositorySyncTransactionRunner,
		row: RepositorySyncPendingHeadRow,
		runId: string,
	): Promise<{
		applied: boolean;
		settled: RepositorySyncPendingHeadSettlement;
	}>;
	/** The syncs that follow `ref` on the pushed repository, tenant-consistent only. */
	findByRepository(input: {
		repositoryUrl: string;
		ref: string;
	}): Promise<RepositorySyncPushRow[]>;
	/** Whether the delegate may still publish this subject. */
	checkPermission(row: {
		projectId: string;
		userId: string;
	}): Promise<boolean>;
}

export const REPOSITORY_SYNC_SUBJECT_STORES: Readonly<
	Record<RepositorySyncSubjectKind, RepositorySyncSubjectStore>
> = {
	instructions: {
		kind: "instructions",
		listDueAndClaim: claimDueInstructionSyncRows,
		leaseHeld: instructionSyncLeaseHeld,
		writeBack: writeBackInstructionSync,
		recordCheckFailure: recordInstructionSyncCheckFailure,
		recordPendingHead: (tx, row, commitSha) =>
			recordPendingInstructionSyncHead(tx, {
				syncId: row.id,
				projectId: row.projectId,
				organizationId: row.organizationId,
				generation: row.generation,
				commitSha,
			}),
		settlePendingHead: (client, row, runId) =>
			settlePendingInstructionSyncHead(client, {
				syncId: row.id,
				projectId: row.projectId,
				organizationId: row.organizationId,
				generation: row.generation,
				runId,
			}),
		findByRepository: findInstructionSyncsForPush,
		checkPermission: (row) =>
			canCreateProjectInstructions(row.projectId, row.userId),
	},
};
