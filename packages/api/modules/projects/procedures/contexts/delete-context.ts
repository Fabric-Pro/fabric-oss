import { ORPCError } from "@orpc/client";
import {
	getContextById,
	getContextRepositorySync,
	hasProjectAccess,
} from "@repo/database";
import {
	deleteUrlSourceSchedule,
	getScheduleClient,
	getTemporalClient,
} from "@repo/temporal";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../../lib/authorized-project-tenant";
import { emitActivity, emitContextChange } from "../../../../lib/realtime";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { deleteSyncedContext } from "../../lib/delete-synced-context";
import {
	type RepositoryManagedLabel,
	repositoryManagedError,
} from "../../lib/repository-managed";
import { syncedContextDeleteConflictMessage } from "../../lib/synced-context-conflict";

/** The duplicate guard's refusal, for a synced row as for any other. */
const NO_LONGER_A_DUPLICATE_MESSAGE =
	"This item is no longer a duplicate of the item it was matched with";

/**
 * Which repository and branch own a managed row, for the fast refusal. The
 * project's one sync configuration names it; any other state (the
 * configuration removed or replaced since the row was read) names none, and
 * the message falls back to "the connected repository".
 */
async function repositoryLabelFor(
	projectId: string,
	organizationId: string | null,
	repositorySyncId: string,
): Promise<RepositoryManagedLabel> {
	const sync = organizationId
		? await getContextRepositorySync(projectId, organizationId)
		: null;
	if (!sync || sync.id !== repositorySyncId) {
		return { repository: null, ref: null };
	}
	return {
		repository: `${sync.repositoryIntegration.repositoryOwner}/${sync.repositoryIntegration.repositoryName}`,
		ref: sync.ref,
	};
}

export const deleteContextProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_DELETE))
	.route({
		method: "DELETE",
		path: "/projects/:projectId/contexts/:id",
		tags: ["Projects", "Contexts"],
		summary: "Delete context",
		description:
			"Delete a context from database and Qdrant via Temporal workflow. With `expectedDuplicateOfContextId`, the delete only proceeds while the context still holds the same content as that item in the same project, and answers CONFLICT otherwise. A synced file (a context with a source path) is deleted at once, and only in the version named by `expectedContentHash`, which it requires: another version answers CONFLICT with the stored one, and a file synced from a connected repository answers CONFLICT with `data.code` `REPOSITORY_MANAGED`.",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			/**
			 * A guard only, never the tenant the delete runs under: the
			 * hosting organization comes from the project row (Fizzy #2638).
			 */
			organizationId: z.string().nullable().optional(),
			/**
			 * "Remove duplicates" (Fizzy #2619) names the item this one was
			 * matched against when the list was read. The delete re-checks that
			 * match here, so a stale client snapshot can never delete an item
			 * that has since stopped being a copy.
			 */
			expectedDuplicateOfContextId: z.string().optional(),
			/**
			 * The `contentHash` of the version the tab displays. Required for
			 * a synced file (a row with a `sourcePath`), which is deleted only
			 * in that version (Living Memory design 2026-09-23 §6); ignored
			 * for every other context.
			 */
			expectedContentHash: z
				.string()
				.regex(/^[0-9a-fA-F]{64}$/)
				.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// Check project access
		const hasAccess = await hasProjectAccess(input.projectId, user.id);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Get context to verify it belongs to the project
		const projectContext = await getContextById(input.id);

		if (!projectContext || projectContext.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Context not found",
			});
		}

		// The tenant the deletion runs under is the project's hosting
		// organization, read from the loaded row — never the request body
		// (Fizzy #2638). `requireProjectPermission` authorizes on
		// (projectId, userId) without reading the organization, and
		// `hasProjectAccess` ignores its organization argument, so a
		// caller-supplied id was never verified: the creator of an
		// organization-A project who also belongs to organization B could
		// send B (or null), and the workflow deleted points from B's
		// collection (or the personal arm) before deleting A's row, leaving
		// A's points orphaned. `input.organizationId` stays as a guard only.
		assertInputOrgMatchesProject(
			input.organizationId,
			projectContext.project,
		);
		const organizationId =
			projectContext.project.organizationId ?? undefined;

		// A synced knowledge file (Living Memory design 2026-09-23 §6): no
		// workflow. It is deleted synchronously and row-first by
		// `deleteSyncedContext`, the helper behind `--prune`, only in the
		// version the tab displays, and the answer is final.
		if (projectContext.sourcePath) {
			const { sourcePath, repositorySyncId } = projectContext;
			// Fast path, before any other work: the repository owns this
			// row. The helper's guard refuses it too, if it is adopted after
			// this read.
			if (repositorySyncId) {
				throw repositoryManagedError(
					sourcePath,
					await repositoryLabelFor(
						input.projectId,
						projectContext.project.organizationId,
						repositorySyncId,
					),
				);
			}
			if (input.expectedContentHash === undefined) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"expectedContentHash is required to delete a synced file: the Context tab must send the contentHash of the version it displays, so a version changed since is never deleted unseen.",
				});
			}
			const expectedContentHash = input.expectedContentHash.toLowerCase();

			// Remove duplicates (Fizzy #2619), combined with the hash guard:
			// the original must still hold the version this copy is deleted
			// in, and the delete itself is guarded on that version.
			if (input.expectedDuplicateOfContextId !== undefined) {
				const original = await getContextById(
					input.expectedDuplicateOfContextId,
				);
				if (
					!original ||
					original.id === projectContext.id ||
					original.projectId !== input.projectId ||
					original.contentHash !== expectedContentHash
				) {
					throw new ORPCError("CONFLICT", {
						message: NO_LONGER_A_DUPLICATE_MESSAGE,
					});
				}
			}

			const result = await deleteSyncedContext({
				projectId: input.projectId,
				sourcePath,
				expectedContentHash,
				contextId: projectContext.id,
				userId: user.id,
				// The hosting organization, from the project row.
				organizationId: projectContext.project.organizationId,
				via: "web",
				request: context,
			});
			if (result.status === "conflict") {
				throw new ORPCError("CONFLICT", {
					message: syncedContextDeleteConflictMessage(),
					data: result,
				});
			}
			// `deleted`, or `absent` when it went since the tab read it.
			// `deleteSyncedContext` recorded and published it.
			return { success: true, ...result };
		}

		// Duplicate removal (Fizzy #2619): the caller decided this row was a
		// copy from a list it read earlier. Content can change and the
		// original can be deleted in between, so the match is re-established
		// from the stored rows before anything is torn down.
		if (input.expectedDuplicateOfContextId !== undefined) {
			const original = projectContext.contentHash
				? await getContextById(input.expectedDuplicateOfContextId)
				: null;
			if (
				!original ||
				original.id === projectContext.id ||
				original.projectId !== input.projectId ||
				original.contentHash !== projectContext.contentHash
			) {
				throw new ORPCError("CONFLICT", {
					message: NO_LONGER_A_DUPLICATE_MESSAGE,
				});
			}
		}

		// Lock-while-crawling guard for LINK contexts. Deleting mid-crawl
		// would orphan the running Temporal workflow (it would keep writing
		// upserts against a row about to be cascade-deleted, throwing on
		// every page) and leave stranded ProjectContextUrlPage rows behind.
		// Force the user to cancel the crawl first — the cancel-url-source
		// procedure handles cleanup gracefully via the workflow's
		// CancellationScope.nonCancellable finalize branch. Other context
		// types (FILE / TEXT / MEETING_TRANSCRIPT) don't have crawls, so the
		// guard is LINK-only.
		if (
			projectContext.type === "LINK" &&
			(projectContext.extractionStatus === "PENDING" ||
				projectContext.extractionStatus === "EXTRACTING")
		) {
			throw new ORPCError("CONFLICT", {
				message:
					"Processing is currently running for this URL source. Cancel it before deleting the source.",
			});
		}

		// Prepare context name for events
		const contextName =
			projectContext.originalFilename ||
			projectContext.sourceTitle ||
			`${projectContext.type} context`;

		// URL Context Sources: if this is a LINK row with
		// a scheduled cadence (DAILY/WEEKLY/MONTHLY), drop the Temporal
		// Schedule BEFORE the deletion workflow runs so we don't leave an
		// orphan firing against a deleted contextId. Best-effort —
		// failures here don't block the deletion path; the reconciliation
		// workflow (Group 5) sweeps any drift.
		if (projectContext.type === "LINK" && projectContext.urlScheduleId) {
			try {
				const scheduleClient = await getScheduleClient();
				await deleteUrlSourceSchedule(
					{ scheduleId: projectContext.urlScheduleId },
					scheduleClient,
				);
				console.log(
					`[DeleteContext] Deleted URL source schedule ${projectContext.urlScheduleId} for context ${input.id}`,
				);
			} catch (error) {
				console.error(
					`[DeleteContext] Failed to delete URL source schedule for ${input.id}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				// Continue with deletion — the reconciliation workflow will
				// clean this up on the next sweep.
			}
		}

		// Start Temporal workflow for durable deletion
		try {
			const client = await getTemporalClient();
			const workflowId = `context-deletion-${input.id}-${Date.now()}`;

			await client.workflow.start(
				"contextDeletionWorkflow",
				withCorrelationMemo({
					taskQueue: "project-documents",
					workflowId,
					args: [
						{
							contextId: input.id,
							projectId: input.projectId,
							userId: user.id,
							organizationId,
							qdrantId: projectContext.qdrantId ?? undefined,
							metadata: {
								contextType: projectContext.type,
								contextName,
								deletedBy: user.name || user.email || user.id,
							},
						},
					],
				}),
			);

			console.log(
				`[DeleteContext] Started context deletion workflow ${workflowId}`,
			);
		} catch (error) {
			console.error(
				`[DeleteContext] Failed to start context deletion workflow for ${input.id}: ${error}`,
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to start context deletion",
			});
		}

		// Emit real-time events for collaboration (immediate feedback)
		await Promise.all([
			emitContextChange({
				projectId: input.projectId,
				contextId: input.id,
				action: "deleted",
				userId: user.id,
				userName: user.name || "Anonymous",
				contextType: projectContext.type,
				contextName,
			}),
			emitActivity({
				projectId: input.projectId,
				userId: user.id,
				userName: user.name || "Anonymous",
				activityType: "context_deleted",
				resourceType: "context",
				resourceId: input.id,
				resourceName: contextName,
				timestamp: new Date().toISOString(),
			}),
		]);

		return { success: true };
	});
