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
 */
import type { Prisma } from "../client";
import {
	claimDueInstructionSyncRows,
	findInstructionSyncsForPush,
	type InstructionSyncPause,
	instructionSyncLeaseHeld,
	type RepositorySyncSchedulingPatch,
	recordInstructionSyncCheckFailure,
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
	/** Leases up to `limit` due rows at `leaseUntil`, oldest due first. Cross-tenant. */
	listDueAndClaim(
		tx: Prisma.TransactionClient,
		input: { limit: number; leaseUntil: Date; now?: Date },
	): Promise<ClaimedRepositorySyncRow[]>;
	/** Whether a row still matches the fence. */
	leaseHeld(
		tx: Prisma.TransactionClient,
		fence: RepositorySyncFence,
	): Promise<boolean>;
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
		findByRepository: findInstructionSyncsForPush,
		checkPermission: (row) =>
			canCreateProjectInstructions(row.projectId, row.userId),
	},
};
