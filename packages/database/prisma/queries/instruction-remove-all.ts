/**
 * Remove a project's coding instructions entirely: every snapshot of the
 * project, everything that hangs off them, and the published pointer, in ONE
 * transaction, so the project answers every reader exactly as one that never
 * had coding instructions does. The admin then starts over with a first
 * upload, whose version allocation restarts at 1 because no row is left.
 *
 * # What goes, and how
 *
 *  - `Project.publishedInstructionSnapshotId` is cleared FIRST. The pointer's
 *    foreign key is `onDelete: Restrict`, so the published snapshot cannot
 *    be deleted while it is pointed at.
 *  - Files, git intent entries and proposal approvals are deleted explicitly,
 *    under the tenant filter, rather than left to their `Cascade`, so the
 *    whole removal is one tenant-filtered transaction, as in
 *    `deleteInstructionSnapshot`.
 *  - The snapshots themselves. `baseSnapshotId` is `SetNull` between rows
 *    that all go in this transaction, and `proposalBranchId` points from the
 *    snapshot to its branch, so neither blocks the delete.
 *  - One storage-cleanup receipt per snapshot, in this transaction, because
 *    once the rows are gone a receipt is the only durable record of where
 *    their objects live (`instruction-pending-storage-cleanup.ts`).
 *  - Every member's "last seen" marker for the tab's digest
 *    (`ProjectUserPreference.instructionsSeen*`) is cleared, so the next
 *    visit is a first visit. The marker is deliberately not a foreign key,
 *    and a marker naming version 7 would otherwise make a fresh version 1
 *    look already seen.
 *  - The publish notification claim (`publishNotifiedAt`) is a column of the
 *    snapshot row and goes with it. Notifications already delivered stay.
 *
 * # What stays
 *
 *  - The repository sync configuration and its run history
 *    (`ProjectInstructionRepositorySyncRun`, whose `snapshotId` is a plain
 *    column on purpose). A configured sync refuses the removal instead.
 *  - Member proposal branches, their push journal
 *    (`ProjectInstructionProposalBranchOperation`, whose `snapshotId` is a
 *    plain column so the journal outlives the proposal row) and the
 *    permanent ref reservations: Fabric never deletes those rows, and a
 *    branch whose proposals are gone is the state retention already leaves.
 *  - The settings (ignore rules, review policy) and repository read-access
 *    grants: configuration, not instructions.
 *  - Earlier audit rows.
 *
 * # What it refuses
 *
 * Decided under the project row's lock and the snapshot rows' locks, so the
 * answer cannot be raced:
 *  - `repository_mode`: the project keeps its instructions in a repository
 *    (`sourceOfTruth: "REPOSITORY"`, or a sync row exists). Its next sync
 *    would bring them straight back; the admin switches to upload mode first;
 *  - `migration_open`: a move of the uploads into a repository is open, and
 *    its pull request is made of these rows;
 *  - `active`: a snapshot is RECEIVING or VALIDATING, so a workflow (or an
 *    upload in a browser) still reads or writes it;
 *  - `pull_request_unresolved`: a proposal's pull request may still be
 *    pushed, opened, closed or settled (`isUnresolvedPullRequestOperation`),
 *    so its operation still reads the row;
 *  - `proposal_pending`: a proposal waits for review. Someone else's work is
 *    decided by approving or rejecting it, not swept away with the rest.
 *
 * Idempotent: a project with no snapshots answers `removed` with nothing
 * removed, changes nothing and writes no audit row, as the Living Memory
 * reset does.
 *
 * Authorization is the CALLER's job and must happen before this is reached.
 */

import { db, type Prisma } from "../client";
import { type RecordAuditInput, recordAuditTx } from "./audit-log";
import { migrationOfSettings } from "./instruction-migration-pointer";
import { createInstructionStorageCleanupReceipts } from "./instruction-pending-storage-cleanup";
import { isUnresolvedPullRequestOperation } from "./instruction-proposal-pull-requests";

/**
 * Every coding-instructions version of a project removed at once. One row
 * per removal that removed something: the count and the version that was
 * published, never a path or any content.
 */
export const INSTRUCTIONS_REMOVED_AUDIT_ACTION =
	"project.instructions.removed" as const;

/** Bind parameters one `IN` list carries. */
const REMOVE_ID_CHUNK = 1000;

/**
 * A removal deletes every file row of every version in one transaction,
 * which for a long-lived project is far more than Prisma's 5 s default.
 */
const REMOVE_TRANSACTION_TIMEOUT_MS = 30_000;

/** The statuses in which no workflow reads or writes a snapshot. */
const SETTLED_STATUSES = new Set<string>(["READY", "REJECTED", "FAILED"]);

export type RemoveAllInstructionsRefusal =
	| "not_found"
	| "repository_mode"
	| "migration_open"
	| "active"
	| "pull_request_unresolved"
	| "proposal_pending";

export type RemoveAllInstructionsResult =
	/**
	 * `snapshotIds` are the rows this removal deleted, empty when there was
	 * nothing to remove; `publishedVersion` is the version that was published,
	 * null when none was.
	 */
	| {
			status: "removed";
			snapshotIds: string[];
			publishedVersion: number | null;
	  }
	/** Nothing happened. */
	| { status: "refused"; reason: RemoveAllInstructionsRefusal };

export interface RemoveAllInstructionsInput {
	projectId: string;
	/** The hosting organization, resolved by the caller, never a request value. */
	organizationId: string;
	/** Who removed them and the request they came from, for the audit row. */
	audit: Pick<
		RecordAuditInput,
		| "actor"
		| "ipAddress"
		| "userAgent"
		| "requestId"
		| "sessionId"
		| "correlationId"
	>;
}

/** A storage key a snapshot row names, with the snapshot that names it. */
export interface InstructionStorageKeyRow {
	snapshotId: string;
	storageKey: string;
}

function chunks<T>(items: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += REMOVE_ID_CHUNK) {
		out.push(items.slice(i, i + REMOVE_ID_CHUNK));
	}
	return out;
}

function sourceIsRepository(settings: unknown): boolean {
	return (
		typeof settings === "object" &&
		settings !== null &&
		"sourceOfTruth" in settings &&
		settings.sourceOfTruth === "REPOSITORY"
	);
}

/** What a removal is refused for, read from the project alone. */
function projectRefusal(
	instructionSettings: unknown,
	hasSync: boolean,
): "migration_open" | "repository_mode" | null {
	if (migrationOfSettings(instructionSettings) !== null) {
		return "migration_open";
	}
	if (hasSync || sourceIsRepository(instructionSettings)) {
		return "repository_mode";
	}
	return null;
}

/** The snapshot columns a removal is decided on. */
const decisionSelect = {
	id: true,
	version: true,
	status: true,
	proposalStatus: true,
	pullRequestState: true,
	mergeSyncRequestedAt: true,
	pullRequestObligationOpen: true,
	proposalDestination: true,
	commitOutcome: true,
	proposalBranch: {
		select: {
			state: true,
			untracked: true,
			membership: true,
			mergeSyncRequestedAt: true,
			createIssuedAt: true,
			confirmationDueAt: true,
		},
	},
} satisfies Prisma.ProjectInstructionSnapshotSelect;

type DecisionSnapshot = Prisma.ProjectInstructionSnapshotGetPayload<{
	select: typeof decisionSelect;
}>;

/** What a removal is refused for, read from the snapshots. */
function snapshotRefusal(
	snapshots: readonly DecisionSnapshot[],
): "active" | "pull_request_unresolved" | "proposal_pending" | null {
	if (snapshots.some((s) => !SETTLED_STATUSES.has(s.status))) {
		return "active";
	}
	if (snapshots.some((s) => isUnresolvedPullRequestOperation(s))) {
		return "pull_request_unresolved";
	}
	if (snapshots.some((s) => s.proposalStatus === "PENDING")) {
		return "proposal_pending";
	}
	return null;
}

/**
 * What a removal would do now, for the confirmation: how many versions it
 * deletes (every snapshot of the project, whoever may see it in History),
 * the version that is published, and the refusal it would meet. Read without
 * locks, so it is advice: `removeAllProjectInstructions` decides again under
 * its locks. `null` when the project is not in this organization.
 */
export interface RemoveAllInstructionsPreview {
	snapshotCount: number;
	publishedVersion: number | null;
	blockedBy: Exclude<RemoveAllInstructionsRefusal, "not_found"> | null;
}

export async function previewRemoveAllProjectInstructions(
	projectId: string,
	organizationId: string,
): Promise<RemoveAllInstructionsPreview | null> {
	const [project, sync, snapshots] = await Promise.all([
		db.project.findFirst({
			where: { id: projectId, organizationId },
			select: {
				instructionSettings: true,
				publishedInstructionSnapshotId: true,
			},
		}),
		db.projectInstructionRepositorySync.findFirst({
			where: { projectId, organizationId },
			select: { id: true },
		}),
		db.projectInstructionSnapshot.findMany({
			where: { projectId, organizationId },
			select: decisionSelect,
		}),
	]);
	if (project === null) {
		return null;
	}
	return {
		snapshotCount: snapshots.length,
		publishedVersion:
			snapshots.find(
				(s) => s.id === project.publishedInstructionSnapshotId,
			)?.version ?? null,
		blockedBy:
			projectRefusal(project.instructionSettings, sync !== null) ??
			snapshotRefusal(snapshots),
	};
}

/**
 * Every storage key the project's snapshot rows name: each file row's object
 * and each git intent entry's staged blob. Read BEFORE the removal, because
 * the rows are the only record of where the objects live; the caller keeps
 * only the keys each snapshot owns (`isKeyOwnedBySnapshot`), as the
 * single-version delete does. Tenant-scoped on both columns.
 */
export async function listProjectInstructionStorageKeys(
	projectId: string,
	organizationId: string,
): Promise<InstructionStorageKeyRow[]> {
	const [files, entries] = await Promise.all([
		db.projectInstructionFile.findMany({
			where: { projectId, organizationId },
			select: { snapshotId: true, storageKey: true },
		}),
		db.projectInstructionGitIntentEntry.findMany({
			where: { projectId, organizationId, storageKey: { not: null } },
			select: { snapshotId: true, storageKey: true },
		}),
	]);
	return [
		...files,
		...entries.flatMap((entry) =>
			entry.storageKey === null
				? []
				: [
						{
							snapshotId: entry.snapshotId,
							storageKey: entry.storageKey,
						},
					],
		),
	];
}

export async function removeAllProjectInstructions(
	input: RemoveAllInstructionsInput,
): Promise<RemoveAllInstructionsResult> {
	const { projectId, organizationId } = input;
	return await db.$transaction(
		async (tx): Promise<RemoveAllInstructionsResult> => {
			// LOCK ORDER: project, then snapshots, as `deleteInstructionSnapshot`
			// takes them. The project lock serializes against a publish, a
			// settings write (mode flip, move into a repository) and a new
			// upload, whose snapshot insert needs a key-share lock on this row.
			const [project] = await tx.$queryRaw<
				Array<{
					instructionSettings: unknown;
					publishedInstructionSnapshotId: string | null;
				}>
			>`
				SELECT p."instructionSettings", p."publishedInstructionSnapshotId"
				FROM "project" p
				WHERE p."id" = ${projectId}
					AND p."organizationId" = ${organizationId}
				FOR UPDATE OF p
			`;
			if (project === undefined) {
				return { status: "refused", reason: "not_found" };
			}
			const sync = await tx.projectInstructionRepositorySync.findFirst({
				where: { projectId, organizationId },
				select: { id: true },
			});
			const refusedForProject = projectRefusal(
				project.instructionSettings,
				sync !== null,
			);
			if (refusedForProject !== null) {
				return { status: "refused", reason: refusedForProject };
			}

			// The snapshot rows' own locks: a "Try again" that would move a
			// FAILED row back to VALIDATING, or a pull-request transition,
			// waits for this transaction and then finds the row gone.
			const locked = await tx.$queryRaw<Array<{ id: string }>>`
				SELECT s."id"
				FROM "project_instruction_snapshot" s
				WHERE s."projectId" = ${projectId}
					AND s."organizationId" = ${organizationId}
				ORDER BY s."id"
				FOR UPDATE OF s
			`;
			if (locked.length === 0) {
				return {
					status: "removed",
					snapshotIds: [],
					publishedVersion: null,
				};
			}
			const snapshotIds = locked.map((row) => row.id);

			const snapshots = await tx.projectInstructionSnapshot.findMany({
				where: { projectId, organizationId, id: { in: snapshotIds } },
				select: decisionSelect,
			});
			const refusedForSnapshots = snapshotRefusal(snapshots);
			if (refusedForSnapshots !== null) {
				return { status: "refused", reason: refusedForSnapshots };
			}

			const publishedVersion =
				snapshots.find(
					(s) => s.id === project.publishedInstructionSnapshotId,
				)?.version ?? null;
			if (project.publishedInstructionSnapshotId !== null) {
				await tx.project.update({
					where: { id: projectId, organizationId },
					data: { publishedInstructionSnapshotId: null },
				});
			}

			let deleted = 0;
			for (const ids of chunks(snapshotIds)) {
				const scope = {
					projectId,
					organizationId,
					snapshotId: { in: ids },
				};
				await tx.projectInstructionProposalApproval.deleteMany({
					where: scope,
				});
				await tx.projectInstructionGitIntentEntry.deleteMany({
					where: scope,
				});
				await tx.projectInstructionFile.deleteMany({ where: scope });
				const { count } =
					await tx.projectInstructionSnapshot.deleteMany({
						where: { projectId, organizationId, id: { in: ids } },
					});
				deleted += count;
			}
			if (deleted !== snapshotIds.length) {
				// Unreachable while the rows are locked; if it ever happens, the
				// receipts and the audit row below would describe rows this
				// transaction did not delete, so nothing commits.
				throw new Error(
					`Removed ${deleted} of ${snapshotIds.length} locked instruction snapshots`,
				);
			}

			await createInstructionStorageCleanupReceipts(tx, {
				snapshotIds,
				projectId,
				organizationId,
			});

			await tx.projectUserPreference.updateMany({
				where: {
					projectId,
					organizationId,
					instructionsSeenAt: { not: null },
				} satisfies Prisma.ProjectUserPreferenceWhereInput,
				data: {
					instructionsSeenSnapshotId: null,
					instructionsSeenVersion: null,
					instructionsSeenAt: null,
				},
			});

			await recordAuditTx(tx, {
				action: INSTRUCTIONS_REMOVED_AUDIT_ACTION,
				category: "project",
				severity: "warning",
				organizationId,
				projectId,
				actor: input.audit.actor,
				resource: { type: "project", id: projectId },
				metadata: {
					removedSnapshotCount: snapshotIds.length,
					publishedVersion,
				},
				ipAddress: input.audit.ipAddress,
				userAgent: input.audit.userAgent,
				requestId: input.audit.requestId,
				sessionId: input.audit.sessionId,
				correlationId: input.audit.correlationId,
			});

			return { status: "removed", snapshotIds, publishedVersion };
		},
		{ timeout: REMOVE_TRANSACTION_TIMEOUT_MS },
	);
}
