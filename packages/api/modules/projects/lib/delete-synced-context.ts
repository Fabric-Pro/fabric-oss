/**
 * Delete a synced text file from a project's Context by its path — but only
 * the version the caller names (Fizzy #2636). The ONE function behind the
 * `projects.contexts.deleteSyncedFile` procedure, the v1 REST route
 * `DELETE /api/v1/projects/:projectId/contexts/synced-files` that `fabric
 * context push --prune` calls, and the Context tab's delete of a row with a
 * `sourcePath` (`delete-context.ts`), so the index cleanup, the audit row and
 * the realtime refresh cannot drift between them.
 *
 * Every answer is final:
 *  - the path holds the named version of an unowned row → the row is
 *    deleted, its vector cleanup queued and its audit row written: `deleted`;
 *  - the path holds another version (someone changed it since the caller
 *    last saw it), or another row than the one the caller displayed →
 *    `conflict` with the stored version's stamp, nothing deleted. Deleting it
 *    anyway means naming that version;
 *  - no row at the path → `absent`, which is also what a retry of a delete
 *    whose response was lost hears;
 *  - the row belongs to a Living Memory repository sync → CONFLICT with
 *    `data.code: "REPOSITORY_MANAGED"` naming the repository and branch
 *    (`repository-managed.ts`), nothing deleted: the repository is where it
 *    is removed.
 *
 * ## Synchronous and row-first (Living Memory design 2026-09-23 §6)
 *
 * `deleteSyncedContextRow` (`@repo/database`) runs ONE transaction: the
 * guarded `DELETE` (the id when the tab names one, the project, the tenant,
 * the path, the named hash and `repositorySyncId IS NULL`), a
 * `ProjectContextPendingVectorCleanup` record for the row's points, and the
 * `project.context_source.synced_file_deleted` audit row. The row is never
 * gone without its points recorded for deletion, and a repository sync's
 * adoption and this delete serialize on the row: whichever commits first
 * makes the other's guard match nothing.
 *
 * After the commit this request makes ONE bounded attempt to drain that
 * record with the pending-vector-cleanup sweep's own drain
 * (`drainPendingVectorCleanup`). A failure or a timeout is logged at warn and
 * left to the sweep; it never fails the request, because the row is already
 * deleted and recorded. Until the points go, retrieval resolves every vector
 * hit through Postgres and drops the missing row, so what remains costs a
 * candidate slot, never stale content.
 *
 * Then it publishes the delete as `publishSyncedContextDeleted` did: the
 * context-change and activity events the Context tab's delete emits.
 *
 * This replaces `syncedContextDeletionWorkflow` (claim → vectors → row), which
 * no caller starts any more; it stays registered in `@repo/temporal` for
 * executions open at deploy time. The `in-progress` (202) answer that
 * workflow's bounded wait produced is no longer produced here; `fabric
 * context push` keeps handling it only for an older server.
 *
 * ## Authorization is the caller's
 *
 * As for the upsert: the procedure, the v1 route and the tab each resolve the
 * caller's LIVE `CONTEXT_DELETE` on the project and its hosting organization,
 * and visibility, before calling this. `organizationId` is that hosting
 * organization, never a caller-supplied value.
 */

import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/client";
import {
	ContextSourcePathError,
	deleteSyncedContextRow,
	normalizeContextSourcePath,
	type PendingVectorCleanupRecord,
	type SyncedContextDeleteRow,
} from "@repo/database";
import { logger } from "@repo/logs";
import { drainPendingVectorCleanup } from "@repo/temporal/delete-channel-context";
import {
	type AuditRequestContext,
	auditRequestFields,
} from "../../../lib/audit";
import { emitActivity, emitContextChange } from "../../../lib/realtime";
import { markCuratedAuditWritten } from "../../../orpc/middleware/audit-timing-middleware";
import type { SyncedContextSurface } from "./context-content-audit";
import { repositoryManagedError } from "./repository-managed";
import {
	resolveSyncedContextEditor,
	SHA256_HEX,
	type SyncedContextConflict,
} from "./upsert-synced-context";

export interface DeleteSyncedContextInput {
	projectId: string;
	/** As the caller sent it; normalized here. */
	sourcePath: string;
	/** The `contentHash` of the version the caller means to delete. Required. */
	expectedContentHash: string | null | undefined;
	/**
	 * The row the caller displayed, when it addresses one (the Context tab).
	 * Only that row is deleted; another row at the path is a `conflict`.
	 */
	contextId?: string;
	/** The human the request acts as. Never a client-supplied field. */
	userId: string;
	/** The project's hosting organization, resolved server-side. */
	organizationId: string | null;
	via: SyncedContextSurface;
	/** The request, for the audit row and the realtime events. */
	request: AuditRequestContext;
}

export type DeleteSyncedContextResult =
	| {
			status: "deleted";
			/**
			 * The deleted row. Null only when the answer came from this
			 * operation's audit receipt rather than the delete itself, which a
			 * single request cannot produce (its operation id is its own).
			 */
			contextId: string | null;
			sourcePath: string;
			/** The hash of the version that was deleted. */
			contentHash: string;
	  }
	/** No row at the path: deleted already, or never pushed. */
	| { status: "absent"; sourcePath: string }
	| {
			status: "conflict";
			/** The row that was kept. */
			contextId: string;
			sourcePath: string;
			/** The hash this call named — the version it meant to delete. */
			contentHash: string;
			/** The version stored instead. Never its content. */
			current: SyncedContextConflict;
	  };

/**
 * How long the one drain attempt after the commit may take before the
 * request answers without it. The row is deleted and its cleanup queued by
 * then; the sweep finishes whatever this attempt does not.
 */
export const SYNCED_CONTEXT_CLEANUP_DRAIN_MS = 10_000;

function badRequest(message: string): ORPCError<"BAD_REQUEST", unknown> {
	return new ORPCError("BAD_REQUEST", { message });
}

function validate(input: DeleteSyncedContextInput): {
	sourcePath: string;
	expectedContentHash: string;
} {
	let sourcePath: string;
	try {
		sourcePath = normalizeContextSourcePath(input.sourcePath);
	} catch (error) {
		if (error instanceof ContextSourcePathError) {
			throw badRequest(error.message);
		}
		throw error;
	}
	const expectedContentHash = input.expectedContentHash?.toLowerCase();
	if (!expectedContentHash || !SHA256_HEX.test(expectedContentHash)) {
		throw badRequest(
			"expectedContentHash is required: the 64-character sha256 hex 'contentHash' of the version you mean to delete",
		);
	}
	return { sourcePath, expectedContentHash };
}

/**
 * The name a synced row goes by: its stored title, else its path's basename.
 * The rule of `storedSyncedContextTitle` in `upsert-synced-context.ts`.
 */
function syncedContextTitle(
	row: SyncedContextDeleteRow,
	sourcePath: string,
): string {
	const metadata = row.metadata;
	const title =
		metadata && typeof metadata === "object" && !Array.isArray(metadata)
			? (metadata as { title?: unknown }).title
			: undefined;
	return typeof title === "string" && title.trim()
		? title
		: sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
}

/**
 * One bounded attempt to drain the cleanup record the delete queued. Never
 * throws: a failure or a timeout leaves the record to the sweep.
 */
async function drainOnce(record: PendingVectorCleanupRecord): Promise<void> {
	const where = `cleanup ${record.id} (context ${record.contextIds.join(", ")}, project ${record.projectId})`;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const drain = drainPendingVectorCleanup(record);
	// If the bound wins, the drain still settles later with nobody awaiting
	// it; its failure must not surface as an unhandled rejection.
	drain.catch(() => undefined);
	try {
		const outcome = await Promise.race([
			drain.then(() => "drained" as const),
			new Promise<"timeout">((resolve) => {
				timer = setTimeout(
					() => resolve("timeout"),
					SYNCED_CONTEXT_CLEANUP_DRAIN_MS,
				);
			}),
		]);
		if (outcome === "timeout") {
			logger.warn(
				`[DeleteSyncedContext] Draining ${where} took longer than ${SYNCED_CONTEXT_CLEANUP_DRAIN_MS} ms; leaving it to the pending-vector-cleanup sweep`,
			);
		}
	} catch (error) {
		logger.warn(
			`[DeleteSyncedContext] Could not drain ${where}; leaving it to the pending-vector-cleanup sweep: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		clearTimeout(timer);
	}
}

export async function deleteSyncedContext(
	input: DeleteSyncedContextInput,
): Promise<DeleteSyncedContextResult> {
	const { sourcePath, expectedContentHash } = validate(input);

	// ADR-018, as in the upsert: never the fail-closed personal arm.
	const organizationId = input.organizationId;
	if (!organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message: "Synced context files require an organization project",
		});
	}

	// This request's own operation: the audit row is keyed by it.
	const operationId = randomUUID();
	const outcome = await deleteSyncedContextRow({
		projectId: input.projectId,
		organizationId,
		sourcePath,
		expectedContentHash,
		...(input.contextId !== undefined
			? { contextId: input.contextId }
			: {}),
		userId: input.userId,
		operationId,
		audit: { via: input.via, ...auditRequestFields(input.request) },
	});

	switch (outcome.status) {
		case "absent":
			return { status: "absent", sourcePath };

		case "repository-managed":
			throw repositoryManagedError(
				outcome.context.sourcePath ?? sourcePath,
				outcome.sync,
			);

		case "conflict": {
			const { current } = outcome;
			return {
				status: "conflict",
				contextId: current.contextId,
				sourcePath,
				contentHash: expectedContentHash,
				current: {
					contextId: current.contextId,
					contentHash: current.contentHash,
					contentUpdatedAt: current.contentUpdatedAt,
					contentUpdatedBy: await resolveSyncedContextEditor(
						current.contentUpdatedByUserId,
					),
				},
			};
		}

		case "deleted":
			break;
	}

	// The curated audit row committed with the delete; tell the activity
	// capture, or it adds a generic `activity.*` row for this call.
	markCuratedAuditWritten();

	const { context, cleanupId } = outcome;
	if (!context || !cleanupId) {
		// Answered from this operation's receipt: an earlier attempt already
		// deleted, queued and published.
		return {
			status: "deleted",
			contextId: input.contextId ?? null,
			sourcePath,
			contentHash: expectedContentHash,
		};
	}

	await drainOnce({
		id: cleanupId,
		projectId: input.projectId,
		contextIds: [context.id],
		// As `createPendingVectorCleanup` wrote it for an organization.
		userId: null,
		organizationId,
	});

	// The events the Context tab's delete emits (`delete-context.ts`), as
	// `publishSyncedContextDeleted` emitted them from the workflow. Both
	// emitters swallow their own delivery failures.
	const userName = input.request.user?.name || "Anonymous";
	const contextName = syncedContextTitle(context, sourcePath);
	await Promise.all([
		emitContextChange({
			projectId: input.projectId,
			contextId: context.id,
			action: "deleted",
			userId: input.userId,
			userName,
			contextType: context.type,
			contextName,
		}),
		emitActivity({
			projectId: input.projectId,
			userId: input.userId,
			userName,
			activityType: "context_deleted",
			resourceType: "context",
			resourceId: context.id,
			resourceName: contextName,
			timestamp: new Date().toISOString(),
		}),
	]);

	return {
		status: "deleted",
		contextId: context.id,
		sourcePath,
		contentHash: expectedContentHash,
	};
}
