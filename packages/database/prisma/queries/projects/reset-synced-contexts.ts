/**
 * Reset a project's Living Memory: delete EVERY synced knowledge file (every
 * `ProjectContext` row with a `sourcePath`) of one project, in one
 * transaction, with its vector cleanup queued and one audit row written in
 * that same transaction.
 *
 * The escape hatch for a project whose synced files are in a state the
 * per-file delete cannot untangle: afterwards nothing is listed by the
 * Context tab, `fabric context list` or the MCP file listing, which all read
 * these rows, and `fabric context push --init` can repopulate the project
 * from a local folder.
 *
 * # What it refuses
 *
 * A project with a Living Memory repository sync configured. The sync is the
 * author of record of the rows it wrote and would bring them straight back
 * on its next run, so the member is told to disconnect it first (disabling a
 * sync keeps its files and releases them, after which a reset removes them).
 *
 * # Concurrency
 *
 * It serializes the way the per-file delete does, on the rows, plus lock 1 of
 * the repository sync (`lockContextRepositorySyncByProject`) when the project is an organization project:
 *  - the configuration row is read `FOR UPDATE` first, so a configure or a
 *    disable that is in flight finishes before the reset decides, and one
 *    that starts after waits for it;
 *  - every `DELETE` is guarded on `repositorySyncId IS NULL`, so a row a sync
 *    adopts while the reset runs survives, and is not given a vector cleanup;
 *  - a push that replaces a row the reset is deleting waits on the row lock;
 *    when the reset commits first the push hears the file is gone and
 *    creates it again, which is what a push after a reset means;
 *  - a row created after the reset read the ids is left alone, for the same
 *    reason.
 * A row another delete removed between the read and the `DELETE` is queued
 * for vector cleanup again; deleting points that are already gone is a no-op.
 *
 * Idempotent: a second reset finds nothing, deletes nothing, writes no audit
 * row and queues no cleanup.
 *
 * # One folder
 *
 * With `folder`, only the synced files under that folder of the working
 * tree are deleted (`docs` selects `docs/a.md` and `docs/guides/b.md`, never
 * `docs-archive/c.md`), with the same refusal, the same transaction and an
 * audit row that names the folder. Without it, every synced file.
 *
 * Authorization is the CALLER's job and must happen before this is reached.
 */

import { db, type Prisma } from "../../client";
import { recordAuditTx } from "../audit-log";
import {
	CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS,
	lockContextRepositorySyncByProject,
} from "./context-repository-sync";
import {
	escapeLikeLiteral,
	normalizeSyncedContextResetFolder,
} from "./context-source-path";
import { createPendingVectorCleanup } from "./pending-vector-cleanup";
import type { SyncedContextDeletionAuditContext } from "./synced-context-delete-audit";
import {
	type RepositorySyncLabel,
	readRepositorySyncLabel,
} from "./synced-context-write";

/**
 * A Living Memory reset: every synced file of a project, or of one folder,
 * deleted at once. One row per reset that deleted something, with the count
 * and, for a folder, the folder; never a file's path or any content.
 */
export const SYNCED_CONTEXT_RESET_AUDIT_ACTION =
	"project.context_source.synced_files_reset" as const;

/**
 * How many ids one `IN` list carries. A project can hold thousands of synced
 * files, and one statement with that many bind parameters is refused.
 */
const RESET_ID_CHUNK = 1000;

export interface ResetSyncedContextRowsInput {
	projectId: string;
	/**
	 * The hosting organization, resolved by the caller, never a value the
	 * request supplied. `null` selects the personal arm (`userId`); it is
	 * required so that an `undefined` never selects that arm silently.
	 */
	organizationId: string | null;
	/** The human the request acted as, recorded on the audit row. */
	userId: string;
	/** Stored as the audit row's `metadata.operationId`. */
	operationId: string;
	/** The request the reset came from, for the audit row. */
	audit: SyncedContextDeletionAuditContext;
	/**
	 * Only the synced files under this folder of the working tree, e.g.
	 * `docs/guides`. Normalized with
	 * {@link normalizeSyncedContextResetFolder}, which throws before the
	 * transaction starts. Absent means every synced file.
	 */
	folder?: string;
}

export type ResetSyncedContextRowsResult =
	/**
	 * `deletedIds` are the rows this reset deleted. `cleanupId` is the queued
	 * `ProjectContextPendingVectorCleanup` record for their points, null when
	 * nothing was deleted.
	 */
	| { status: "reset"; deletedIds: string[]; cleanupId: string | null }
	/** A repository sync is configured. Nothing happened. */
	| { status: "repository-sync-active"; sync: RepositorySyncLabel };

function chunks<T>(items: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += RESET_ID_CHUNK) {
		out.push(items.slice(i, i + RESET_ID_CHUNK));
	}
	return out;
}

export async function resetSyncedContextRows(
	input: ResetSyncedContextRowsInput,
): Promise<ResetSyncedContextRowsResult> {
	const { projectId, organizationId } = input;
	const folder =
		input.folder === undefined
			? null
			: normalizeSyncedContextResetFolder(input.folder);
	// Exclusive: the organization arm, or the personal arm. Never OR-ed.
	const tenantFilter = organizationId
		? { organizationId }
		: { organizationId: null, userId: input.userId };

	return await db.$transaction(
		async (tx): Promise<ResetSyncedContextRowsResult> => {
			// Repository syncs are organization-only.
			if (organizationId) {
				const sync = await lockContextRepositorySyncByProject(tx, {
					projectId,
					organizationId,
				});
				if (sync) {
					return {
						status: "repository-sync-active",
						sync: await readRepositorySyncLabel(tx, {
							syncId: sync.id,
							projectId,
						}),
					};
				}
			}

			const scope = {
				projectId,
				...tenantFilter,
				repositorySyncId: null,
				sourcePath:
					folder === null
						? { not: null }
						: { startsWith: escapeLikeLiteral(`${folder}/`) },
			} satisfies Prisma.ProjectContextWhereInput;

			const candidates = await tx.projectContext.findMany({
				where: scope,
				select: { id: true },
			});
			if (candidates.length === 0) {
				return { status: "reset", deletedIds: [], cleanupId: null };
			}
			const candidateIds = candidates.map((row) => row.id);

			for (const ids of chunks(candidateIds)) {
				await tx.projectContext.deleteMany({
					where: { ...scope, id: { in: ids } },
				});
			}
			// What the guard kept: a row adopted by a sync after the read.
			// Its points are live and must not be queued for deletion.
			const kept = new Set<string>();
			for (const ids of chunks(candidateIds)) {
				const survivors = await tx.projectContext.findMany({
					where: { projectId, ...tenantFilter, id: { in: ids } },
					select: { id: true },
				});
				for (const row of survivors) {
					kept.add(row.id);
				}
			}
			const deletedIds = candidateIds.filter((id) => !kept.has(id));
			if (deletedIds.length === 0) {
				return { status: "reset", deletedIds: [], cleanupId: null };
			}

			const cleanupId = await createPendingVectorCleanup(tx, {
				projectId,
				contextIds: deletedIds,
				tenant: { userId: input.userId, organizationId },
			});

			// A user deleted since the request is recorded by no id rather
			// than failing the insert (and with it, the reset).
			const user = await tx.user.findUnique({
				where: { id: input.userId },
				select: { email: true, name: true },
			});
			const { audit } = input;
			await recordAuditTx(tx, {
				action: SYNCED_CONTEXT_RESET_AUDIT_ACTION,
				category: "project",
				severity: "warning",
				organizationId,
				projectId,
				actor: {
					type: "user",
					userId: user ? input.userId : null,
					emailSnapshot: user?.email ?? null,
					nameSnapshot: user?.name ?? null,
					impersonatedById: audit.impersonatedById,
				},
				resource: { type: "project", id: projectId },
				metadata: {
					...(folder === null
						? { scope: "project" }
						: { scope: "folder", folder }),
					deletedCount: deletedIds.length,
					via: audit.via,
					operationId: input.operationId,
				},
				ipAddress: audit.ipAddress,
				userAgent: audit.userAgent,
				requestId: audit.requestId,
				sessionId: audit.sessionId,
				correlationId: audit.correlationId,
			});

			return { status: "reset", deletedIds, cleanupId };
		},
		{ timeout: CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS },
	);
}
