/**
 * Reset a project's Living Memory: delete every synced knowledge file of the
 * project at once. The ONE function behind `projects.contexts.resetLivingMemory`
 * (the Context tab's "Reset Living Memory") and the v1 REST route
 * `POST /api/v1/projects/:projectId/contexts/reset` that `fabric context
 * reset` calls, so the cleanup, the audit row and the realtime refresh
 * cannot drift between them.
 *
 * `resetSyncedContextRows` (`@repo/database`) runs ONE transaction: it locks
 * the project's repository sync configuration, refuses while one exists, and
 * otherwise deletes every unowned row with a `sourcePath`, queues ONE
 * `ProjectContextPendingVectorCleanup` record for their points and writes
 * the `project.context_source.synced_files_reset` audit row with the count.
 * After the commit this makes the per-file delete's one bounded drain
 * attempt and publishes one context change and one activity event.
 *
 * Answers:
 *  - `{ deleted: n }`, `n` being 0 for a project with nothing to reset (a
 *    repeat of a reset is that);
 *  - CONFLICT with `data.code: "REPOSITORY_SYNC_ACTIVE"` naming the
 *    repository and branch, nothing deleted, while a repository sync is
 *    configured: it would bring the files straight back;
 *  - FORBIDDEN for a personal project, as every synced-file surface answers
 *    (ADR-018: never the fail-closed personal arm).
 *
 * Authorization is the CALLER's: visibility, then the caller's LIVE
 * `CONTEXT_DELETE` on the project, resolved server-side. `organizationId` is
 * the project's hosting organization, never a caller-supplied value.
 */

import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { resetSyncedContextRows } from "@repo/database";
import {
	type AuditRequestContext,
	auditRequestFields,
} from "../../../lib/audit";
import { emitActivity, emitContextChange } from "../../../lib/realtime";
import { markCuratedAuditWritten } from "../../../orpc/middleware/audit-timing-middleware";
import type { SyncedContextSurface } from "./context-content-audit";
import { drainSyncedContextCleanupOnce } from "./delete-synced-context";
import type { RepositoryManagedLabel } from "./repository-managed";

export const REPOSITORY_SYNC_ACTIVE_CODE = "REPOSITORY_SYNC_ACTIVE" as const;

export interface RepositorySyncActiveErrorData extends RepositoryManagedLabel {
	code: typeof REPOSITORY_SYNC_ACTIVE_CODE;
}

export interface ResetSyncedContextsInput {
	projectId: string;
	/** The human the request acts as. Never a client-supplied field. */
	userId: string;
	/** The project's hosting organization, resolved server-side. */
	organizationId: string | null;
	via: SyncedContextSurface;
	/** The request, for the audit row and the realtime events. */
	request: AuditRequestContext;
}

export interface ResetSyncedContextsResult {
	/** How many synced files this reset deleted. */
	deleted: number;
}

function repositorySyncActiveMessage(label: RepositoryManagedLabel): string {
	const origin = label.repository
		? label.ref
			? `${label.repository} @ ${label.ref}`
			: label.repository
		: "a connected repository";
	return `This project's Living Memory is synced from ${origin}. Disconnect the repository sync first, then reset: while it is connected, its next run would bring the files back.`;
}

export function repositorySyncActiveError(
	label: RepositoryManagedLabel,
): ORPCError<"CONFLICT", RepositorySyncActiveErrorData> {
	return new ORPCError("CONFLICT", {
		message: repositorySyncActiveMessage(label),
		data: {
			code: REPOSITORY_SYNC_ACTIVE_CODE,
			repository: label.repository,
			ref: label.ref,
		},
	});
}

/**
 * The v1 REST body for a `repositorySyncActiveError`, or `null` for any
 * other error: `{ error: { message, code: "REPOSITORY_SYNC_ACTIVE",
 * repository, ref } }`, answered with 409.
 */
export function repositorySyncActiveBody(error: unknown): {
	error: {
		message: string;
		code: typeof REPOSITORY_SYNC_ACTIVE_CODE;
		repository: string | null;
		ref: string | null;
	};
} | null {
	if (!(error instanceof ORPCError) || error.code !== "CONFLICT") {
		return null;
	}
	const data: unknown = error.data;
	if (
		typeof data !== "object" ||
		data === null ||
		!("code" in data) ||
		data.code !== REPOSITORY_SYNC_ACTIVE_CODE
	) {
		return null;
	}
	const repository =
		"repository" in data && typeof data.repository === "string"
			? data.repository
			: null;
	const ref = "ref" in data && typeof data.ref === "string" ? data.ref : null;
	return {
		error: {
			message: error.message,
			code: REPOSITORY_SYNC_ACTIVE_CODE,
			repository,
			ref,
		},
	};
}

export async function resetSyncedContexts(
	input: ResetSyncedContextsInput,
): Promise<ResetSyncedContextsResult> {
	const { organizationId } = input;
	if (!organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message: "Synced context files require an organization project",
		});
	}

	const outcome = await resetSyncedContextRows({
		projectId: input.projectId,
		organizationId,
		userId: input.userId,
		operationId: randomUUID(),
		audit: { via: input.via, ...auditRequestFields(input.request) },
	});

	switch (outcome.status) {
		case "repository-sync-active":
			throw repositorySyncActiveError(outcome.sync);
		case "reset":
			break;
		default: {
			const unreachable: never = outcome;
			throw new Error(`Unhandled reset outcome: ${String(unreachable)}`);
		}
	}

	const { deletedIds, cleanupId } = outcome;
	const [firstId] = deletedIds;
	if (!cleanupId || firstId === undefined) {
		return { deleted: 0 };
	}

	// The curated audit row committed with the delete; tell the activity
	// capture, or it adds a generic `activity.*` row for this call.
	markCuratedAuditWritten();

	await drainSyncedContextCleanupOnce({
		id: cleanupId,
		projectId: input.projectId,
		contextIds: deletedIds,
		// As `createPendingVectorCleanup` wrote it for an organization.
		userId: null,
		organizationId,
	});

	// One event of each kind, not one per file: a listener refetches the
	// whole list on any context change.
	const userName = input.request.user?.name || "Anonymous";
	const resourceName = `Living Memory (${deletedIds.length} synced ${deletedIds.length === 1 ? "file" : "files"})`;
	await Promise.all([
		emitContextChange({
			projectId: input.projectId,
			contextId: firstId,
			action: "deleted",
			userId: input.userId,
			userName,
			contextName: resourceName,
		}),
		emitActivity({
			projectId: input.projectId,
			userId: input.userId,
			userName,
			activityType: "context_deleted",
			resourceType: "context",
			resourceId: firstId,
			resourceName,
			timestamp: new Date().toISOString(),
		}),
	]);

	return { deleted: deletedIds.length };
}
