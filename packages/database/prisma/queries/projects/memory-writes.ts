/**
 * Living Memory write receipts (ADR-022): storing an admitted write, reading
 * it back, and settling it once.
 *
 * A receipt is the record of one admitted request to write files into a write
 * folder, with the folder, mode, branch and repository integration FROZEN at
 * admission (`submitMemoryWrite`), so it says what was asked of the repository
 * as it stood. It is created `PENDING` and settled exactly once by the write
 * workflow (`settleMemoryWrite`): the update is conditional on `PENDING`, so a
 * retried record is a no-op and a settled receipt never changes.
 *
 * Admission is one transaction under an advisory lock on the member and the
 * project, so the two rules that count rows (an identical request returns the
 * receipt it already has, and a member has at most so many writes pending)
 * cannot be raced past by two requests arriving together. The windows and the
 * cap are the caller's: they belong to the write lane (`@repo/temporal`), which
 * this package cannot import.
 *
 * Everything is scoped to the project AND the organization the caller
 * resolved. The entry rows carry no tenant columns and are reached only
 * through their write.
 */

import { db, type Prisma } from "../../client";
import type {
	ProjectContextWriteMode,
	ProjectMemoryWriteOp,
	ProjectMemoryWriteStatus,
	ProjectMemoryWriteVia,
} from "../../generated/client";
import { recordAuditTx } from "../audit-log";
import { advisoryObjectKey } from "../lib/refresh-lock-key";

/** Where a write stands and which surface it came through: derived from the enums, not restated. */
export type MemoryWriteStatus = ProjectMemoryWriteStatus;
export type MemoryWriteVia = ProjectMemoryWriteVia;

const MEMORY_WRITE_ADVISORY_CLASS = 0x4d577274; // "MWrt"

type Scope = { projectId: string; organizationId: string };

/** One path of a write as it is stored: PUT keeps the key, size and hash of its staged bytes. */
export interface MemoryWriteEntryInput {
	path: string;
	op: ProjectMemoryWriteOp;
	ifMatchOid: string | null;
	stagedKey: string | null;
	bytes: number | null;
	sha256: string | null;
}

/** The target a write is admitted against, as it stood when it was. */
export interface MemoryWriteFrozenTarget {
	id: string;
	version: number;
	folder: string;
	mode: ProjectContextWriteMode;
	/** The sync's branch. */
	ref: string;
	repositoryIntegrationId: string;
}

export type SubmitMemoryWriteResult =
	| {
			kind: "created";
			write: {
				id: string;
				status: ProjectMemoryWriteStatus;
				digest: string;
			};
	  }
	| {
			/** An identical request from the same member is already in flight or succeeded. */
			kind: "deduplicated";
			write: {
				id: string;
				status: ProjectMemoryWriteStatus;
				digest: string;
			};
	  }
	| { kind: "too-many-pending"; pending: number };

/** The statuses an identical request returns the receipt of: in flight, or landed. A failure is tried again. */
const DEDUPLICATED_STATUSES = [
	"PENDING",
	"COMMITTED",
	"PULL_REQUEST",
] as const satisfies readonly ProjectMemoryWriteStatus[];

/**
 * Stores an admitted write: its receipt and its entries, `PENDING`.
 *
 * Order, under the member's lock on the project: an identical request (the
 * same member, the same `digest`) within `dedupeWindowMs` whose receipt is in
 * flight or landed is returned as it is (`deduplicated`); otherwise a member
 * with `maxPending` receipts still `PENDING` newer than `pendingWindowMs` is
 * refused (`too-many-pending`); otherwise the receipt is created. A receipt
 * that was refused, conflicted or failed is not returned: sending the same
 * request again after fixing the cause is a new write. A `PENDING` receipt
 * older than `pendingWindowMs` has no workflow behind it and does not count.
 */
export async function submitMemoryWrite(
	input: Scope & {
		userId: string;
		via: ProjectMemoryWriteVia;
		oauthClientId: string | null;
		target: MemoryWriteFrozenTarget;
		message: string;
		digest: string;
		entries: readonly MemoryWriteEntryInput[];
		dedupeWindowMs: number;
		pendingWindowMs: number;
		maxPending: number;
		now?: Date;
	},
): Promise<SubmitMemoryWriteResult> {
	const now = input.now ?? new Date();
	const scope = {
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: input.userId,
	};
	return db.$transaction(async (tx) => {
		const key = advisoryObjectKey(
			`memwrite:${input.organizationId}:${input.projectId}:${input.userId}`,
		);
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MEMORY_WRITE_ADVISORY_CLASS}::int, ${key}::int)`;

		const existing = await tx.projectMemoryWrite.findFirst({
			where: {
				...scope,
				digest: input.digest,
				status: { in: [...DEDUPLICATED_STATUSES] },
				createdAt: {
					gte: new Date(now.getTime() - input.dedupeWindowMs),
				},
			},
			orderBy: { createdAt: "desc" },
			select: { id: true, status: true, digest: true },
		});
		if (existing) {
			return { kind: "deduplicated", write: existing };
		}

		const pending = await tx.projectMemoryWrite.count({
			where: {
				...scope,
				status: "PENDING",
				createdAt: {
					gte: new Date(now.getTime() - input.pendingWindowMs),
				},
			},
		});
		if (pending >= input.maxPending) {
			return { kind: "too-many-pending", pending };
		}

		const write = await tx.projectMemoryWrite.create({
			data: {
				...scope,
				targetId: input.target.id,
				targetVersion: input.target.version,
				folder: input.target.folder,
				mode: input.target.mode,
				ref: input.target.ref,
				repositoryIntegrationId: input.target.repositoryIntegrationId,
				oauthClientId: input.oauthClientId,
				via: input.via,
				message: input.message,
				digest: input.digest,
				entries: {
					create: input.entries.map((entry) => ({
						path: entry.path,
						op: entry.op,
						ifMatchOid: entry.ifMatchOid,
						stagedKey: entry.stagedKey,
						bytes: entry.bytes,
						sha256: entry.sha256,
					})),
				},
			},
			select: { id: true, status: true, digest: true },
		});
		return { kind: "created", write };
	});
}

const receiptSelect = {
	id: true,
	targetId: true,
	targetVersion: true,
	folder: true,
	mode: true,
	ref: true,
	via: true,
	digest: true,
	status: true,
	outcome: true,
	createdAt: true,
	settledAt: true,
	entries: {
		select: { path: true, op: true },
		orderBy: { path: "asc" },
	},
} satisfies Prisma.ProjectMemoryWriteSelect;

export type MemoryWriteReceiptView = Prisma.ProjectMemoryWriteGetPayload<{
	select: typeof receiptSelect;
}>;

/** A receipt as a reader sees it: status, outcome, and the paths and operations of the write. `null` when it is not this project's. */
export function getMemoryWriteReceipt(
	input: Scope & { writeId: string },
): Promise<MemoryWriteReceiptView | null> {
	return db.projectMemoryWrite.findFirst({
		where: {
			id: input.writeId,
			projectId: input.projectId,
			organizationId: input.organizationId,
		},
		select: receiptSelect,
	});
}

const runSelect = {
	id: true,
	projectId: true,
	organizationId: true,
	userId: true,
	targetId: true,
	targetVersion: true,
	folder: true,
	mode: true,
	ref: true,
	repositoryIntegrationId: true,
	oauthClientId: true,
	via: true,
	message: true,
	digest: true,
	status: true,
	createdAt: true,
	entries: {
		select: {
			path: true,
			op: true,
			ifMatchOid: true,
			stagedKey: true,
			bytes: true,
			sha256: true,
		},
		orderBy: { path: "asc" },
	},
} satisfies Prisma.ProjectMemoryWriteSelect;

export type MemoryWriteRunRow = Prisma.ProjectMemoryWriteGetPayload<{
	select: typeof runSelect;
}>;

/** A receipt with everything the workflow acts on, staged keys included. `null` when it is not this project's. */
export function getMemoryWriteForRun(
	input: Scope & { writeId: string },
): Promise<MemoryWriteRunRow | null> {
	return db.projectMemoryWrite.findFirst({
		where: {
			id: input.writeId,
			projectId: input.projectId,
			organizationId: input.organizationId,
		},
		select: runSelect,
	});
}

/** The facts the write workflow re-checks live, read together, before it touches the repository. */
export interface MemoryWriteRunState {
	readOnlyMode: boolean;
	sync: {
		id: string;
		generation: number;
		userId: string;
		ref: string;
		repositoryIntegrationId: string;
		paths: string[];
		excludedPaths: string[];
		automatic: boolean;
		automaticPausedReason: string | null;
		integration: {
			id: string;
			projectId: string;
			provider: string;
			repositoryUrl: string;
			status: string;
		};
	} | null;
	/** Only a target of the project's own sync. */
	target: {
		id: string;
		version: number;
		folder: string;
		mode: ProjectContextWriteMode;
	} | null;
	instructionRoots: string[];
	/** The member the write acts for: their display name goes into the commit's attribution. */
	userName: string | null;
}

/** `null` when the project is not in this organization. Reads only, and takes no lock. */
export async function getMemoryWriteRunState(
	input: Scope & { targetId: string; userId: string },
): Promise<MemoryWriteRunState | null> {
	const scope = {
		projectId: input.projectId,
		organizationId: input.organizationId,
	};
	const [project, sync, user] = await Promise.all([
		db.project.findFirst({
			where: {
				id: input.projectId,
				organizationId: input.organizationId,
			},
			select: { readOnlyMode: true },
		}),
		db.projectContextRepositorySync.findFirst({
			where: scope,
			select: {
				id: true,
				generation: true,
				userId: true,
				ref: true,
				repositoryIntegrationId: true,
				paths: true,
				excludedPaths: true,
				automatic: true,
				automaticPausedReason: true,
				repositoryIntegration: {
					select: {
						id: true,
						projectId: true,
						provider: true,
						repositoryUrl: true,
						status: true,
					},
				},
			},
		}),
		db.user.findUnique({
			where: { id: input.userId },
			select: { name: true },
		}),
	]);
	if (!project) {
		return null;
	}
	if (!sync) {
		return {
			readOnlyMode: project.readOnlyMode,
			sync: null,
			target: null,
			instructionRoots: [],
			userName: user?.name ?? null,
		};
	}
	const [target, instructionSyncs] = await Promise.all([
		db.projectContextWriteTarget.findFirst({
			where: { id: input.targetId, syncId: sync.id, ...scope },
			select: { id: true, version: true, folder: true, mode: true },
		}),
		db.projectInstructionRepositorySync.findMany({
			where: {
				projectId: input.projectId,
				repositoryIntegrationId: sync.repositoryIntegrationId,
			},
			select: { rootPath: true },
		}),
	]);
	const { repositoryIntegration, ...syncRow } = sync;
	return {
		readOnlyMode: project.readOnlyMode,
		sync: { ...syncRow, integration: repositoryIntegration },
		target,
		instructionRoots: instructionSyncs.map((row) => row.rootPath),
		userName: user?.name ?? null,
	};
}

export type SettleMemoryWriteResult =
	| { applied: true; status: ProjectMemoryWriteStatus }
	/** Settled already (an earlier attempt, or another run); `status` is what it holds. `null`: no such receipt. */
	| { applied: false; status: ProjectMemoryWriteStatus | null };

/**
 * Settles a `PENDING` receipt: status, outcome and `settledAt`, with the
 * `project.context.memory_write_settled` audit row in the same transaction.
 * Conditional on `PENDING`, so it is idempotent: a receipt that is settled
 * already is left as it is and reported (`applied: false`). `outcome` is the
 * typed outcome (validated by the caller); `metadata` is what the audit row
 * adds to the receipt's own facts (counts, codes and ids, never file content).
 */
export async function settleMemoryWrite(
	input: Scope & {
		writeId: string;
		status: Exclude<ProjectMemoryWriteStatus, "PENDING">;
		outcome: Prisma.InputJsonValue;
		metadata: Record<string, unknown>;
	},
): Promise<SettleMemoryWriteResult> {
	return db.$transaction(async (tx) => {
		const write = await tx.projectMemoryWrite.findFirst({
			where: {
				id: input.writeId,
				projectId: input.projectId,
				organizationId: input.organizationId,
			},
			select: {
				userId: true,
				status: true,
				mode: true,
				folder: true,
				ref: true,
				via: true,
				_count: { select: { entries: true } },
			},
		});
		if (!write) {
			return { applied: false, status: null };
		}
		const { count } = await tx.projectMemoryWrite.updateMany({
			where: {
				id: input.writeId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				status: "PENDING",
			},
			data: {
				status: input.status,
				outcome: input.outcome,
				settledAt: new Date(),
			},
		});
		if (count !== 1) {
			return { applied: false, status: write.status };
		}
		await recordAuditTx(tx, {
			action: "project.context.memory_write_settled",
			category: "project",
			outcome: input.status === "FAILED" ? "failure" : "success",
			actor: { type: "user", userId: write.userId },
			organizationId: input.organizationId,
			projectId: input.projectId,
			resource: { type: "project_memory_write", id: input.writeId },
			metadata: {
				status: input.status,
				mode: write.mode,
				folder: write.folder,
				ref: write.ref,
				via: write.via,
				fileCount: write._count.entries,
				...input.metadata,
			},
		});
		return { applied: true, status: input.status };
	});
}
