/**
 * removeAll — remove a project's coding instructions entirely and start over:
 * every version, the published one included, so the project answers every
 * reader (the tab, `getPublished`, the v1 routes, the MCP instruction tools,
 * `fabric instructions sync`) exactly as a project that never had any.
 *
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_DELETE), the project-admin permission
 * that deletes any single version. Visibility first, as on every sibling: the
 * permission resolver's org-role fallback grants an org member permissions on
 * a project hidden from them. The organization is the project's hosting one
 * (`requireHostingOrganizationId`), never a caller-supplied value.
 *
 * `removeAllProjectInstructions` (`@repo/database`) owns the decision and the
 * delete, under the project and snapshot row locks, with the storage-cleanup
 * receipts and the `project.instructions.removed` audit row in the same
 * transaction. This file is the wire contract and the storage sweep.
 *
 * Answers:
 *  - `{ removed, publishedVersion, storageCleanupPending }`; `removed` is 0
 *    for a project with nothing to remove, which changes nothing and writes
 *    no audit row, so a repeat is harmless (as the Living Memory reset);
 *  - CONFLICT, nothing removed, with `data.reason`:
 *    `REPOSITORY_MODE` while the instructions come from a repository (switch
 *    back to upload mode first; the sync configuration and its run history
 *    are never touched here), `MIGRATION_OPEN` while a move into a
 *    repository is open, `SNAPSHOT_ACTIVE` while an upload or an edit is
 *    received or checked, `PULL_REQUEST_UNRESOLVED` while a proposal's pull
 *    request may still change, `PROPOSAL_PENDING` while a proposal waits for
 *    review.
 *
 * Storage goes after the commit, snapshot by snapshot, through the same sweep
 * as the single-version delete. A sweep that fails does not fail the call:
 * the rows are gone and the removal has happened, and every snapshot's
 * receipt keeps its objects in the storage reaper's queue, so the answer
 * says `storageCleanupPending: true` instead.
 */
import { ORPCError } from "@orpc/client";
import {
	listProjectInstructionStorageKeys,
	type RemoveAllInstructionsRefusal,
	removeAllProjectInstructions,
} from "@repo/database";
import { isKeyOwnedBySnapshot } from "@repo/instructions";
import { logger } from "@repo/logs";
import { z } from "zod";
import { auditRequestFields, resolveActor } from "../../../../lib/audit";
import { markCuratedAuditWritten } from "../../../../orpc/middleware/audit-timing-middleware";
import {
	PROJECT_NOT_FOUND_MESSAGE,
	projectNotFoundUnlessVisible,
} from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import { migrationOpenFromRefusal } from "./migration-freeze";
import { REMOVAL_CONFLICT_REASON } from "./remove-all-reasons";
import { deleteSnapshotObjects } from "./snapshot-storage";

/** Throws the answer for a removal the database refused. */
async function refuse(
	reason: RemoveAllInstructionsRefusal,
	i: { projectId: string; organizationId: string },
): Promise<never> {
	switch (reason) {
		case "not_found":
			throw new ORPCError("NOT_FOUND", {
				message: PROJECT_NOT_FOUND_MESSAGE,
			});
		case "migration_open":
			throw await migrationOpenFromRefusal({}, i);
		case "repository_mode":
			throw new ORPCError("CONFLICT", {
				message:
					"This project keeps its coding instructions in a repository. Switch back to upload mode in the coding instructions settings first, then remove them. The repository and its files are not affected.",
				data: { reason: REMOVAL_CONFLICT_REASON.repository_mode },
			});
		case "active":
			throw new ORPCError("CONFLICT", {
				message:
					"An upload or an edit of these coding instructions is still being received or checked. Wait for it to finish, or delete it from History, then try again.",
				data: { reason: REMOVAL_CONFLICT_REASON.active },
			});
		case "pull_request_unresolved":
			throw new ORPCError("CONFLICT", {
				message:
					"A proposal's pull request is still open or being closed. Wait for it to be merged or closed, then try again.",
				data: {
					reason: REMOVAL_CONFLICT_REASON.pull_request_unresolved,
				},
			});
		case "proposal_pending":
			throw new ORPCError("CONFLICT", {
				message:
					"A proposed change to these coding instructions is waiting for review. Approve or reject it first, then try again.",
				data: { reason: REMOVAL_CONFLICT_REASON.proposal_pending },
			});
		default: {
			const unreachable: never = reason;
			throw new Error(
				`Unhandled removal refusal: ${String(unreachable)}`,
			);
		}
	}
}

export const removeAllInstructionsProcedure = tenantProtectedProcedure
	// Visibility before permission: see the file comment.
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_DELETE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/remove-all",
		tags: ["Projects", "Instructions"],
		summary: "Remove the project's coding instructions",
		description:
			"Delete every coding-instructions version of the project, the published one included, so the project has no published coding instructions. Answers `{ removed, publishedVersion, storageCleanupPending }`; `removed` is 0 when there was nothing to remove. Refused with CONFLICT, nothing removed, while the instructions come from a repository, a move into a repository is open, an upload or edit is still being checked, a proposal's pull request is unresolved, or a proposal waits for review.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const tenant = { projectId: input.projectId, organizationId };

		// Storage keys are read BEFORE the rows go, because the rows are the
		// only record of where the objects live. FILTERED to each snapshot's
		// own objects, as the single-version delete does: an edit's inherited
		// rows can name its base's keys until promotion rewrites them, and the
		// base's own sweep is what removes those.
		const keysBySnapshot = new Map<string, string[]>();
		for (const row of await listProjectInstructionStorageKeys(
			input.projectId,
			organizationId,
		)) {
			if (
				!isKeyOwnedBySnapshot(
					row.storageKey,
					input.projectId,
					row.snapshotId,
				)
			) {
				continue;
			}
			const keys = keysBySnapshot.get(row.snapshotId);
			if (keys) {
				keys.push(row.storageKey);
			} else {
				keysBySnapshot.set(row.snapshotId, [row.storageKey]);
			}
		}

		const request = auditRequestFields(context);
		const removal = await removeAllProjectInstructions({
			...tenant,
			audit: {
				actor: resolveActor(context, undefined),
				ipAddress: request.ipAddress,
				userAgent: request.userAgent,
				requestId: request.requestId,
				sessionId: request.sessionId,
				correlationId: request.correlationId,
			},
		});
		if (removal.status === "refused") {
			return await refuse(removal.reason, tenant);
		}
		if (removal.snapshotIds.length === 0) {
			return {
				removed: 0,
				publishedVersion: null,
				storageCleanupPending: false,
			};
		}
		// The curated audit row committed with the delete; tell the activity
		// capture, or it adds a generic `activity.*` row for this call.
		markCuratedAuditWritten();

		let unswept = 0;
		for (const snapshotId of removal.snapshotIds) {
			try {
				await deleteSnapshotObjects({
					projectId: input.projectId,
					snapshotId,
					keys: keysBySnapshot.get(snapshotId) ?? [],
				});
			} catch (error) {
				// Its receipt keeps it queued; the storage reaper retries it.
				unswept += 1;
				logger.warn("[instructions.removeAll] storage sweep failed", {
					projectId: input.projectId,
					snapshotId,
					error:
						error instanceof Error ? error.message : String(error),
				});
			}
		}
		return {
			removed: removal.snapshotIds.length,
			publishedVersion: removal.publishedVersion,
			storageCleanupPending: unswept > 0,
		};
	});
