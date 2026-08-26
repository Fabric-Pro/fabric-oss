/**
 * Cancel Repository Re-index
 *
 * Cancels the in-flight Phase 2 code indexing for one connected repository and
 * finalizes its row so the UI leaves the INDEXING state. PROJECT_ADMIN+ (via
 * PROJECT_SETTINGS_EDIT). Best-effort against an unreachable worker — the row is
 * always finalized even if the Temporal cancel can't be delivered.
 */

import { ORPCError } from "@orpc/client";
import {
	getProjectCodeIndexes,
	getProjectRepoIntegration,
	updateCodeIndexStatus,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { cancelCodeIndexingForRepo } from "../../lib/code-indexing-trigger";

export const cancelReindexRepoIntegrationProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/:projectId/repository-integrations/:integrationId/cancel-reindex",
		tags: ["Projects", "Repository Integrations", "Code Indexing"],
		summary: "Cancel in-flight indexing for a connected repository",
	})
	.input(
		z.object({
			projectId: z.string(),
			integrationId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		const integration = await getProjectRepoIntegration(
			input.integrationId,
			input.projectId,
		);
		if (!integration) {
			throw new ORPCError("NOT_FOUND", {
				message: "Repository integration not found",
			});
		}

		// Best-effort Temporal cancel (awaits workflow termination).
		await cancelCodeIndexingForRepo({
			projectId: input.projectId,
			repositoryIntegrationId: input.integrationId,
		});

		// Finalize the row so it leaves INDEXING even if the worker was down.
		const rows = await getProjectCodeIndexes(input.projectId);
		const row = rows.find(
			(r) => r.repositoryIntegrationId === input.integrationId,
		);
		if (row?.status === "INDEXING") {
			await updateCodeIndexStatus(
				{
					projectId: input.projectId,
					repositoryIntegrationId: input.integrationId,
					branch: row.branch,
				},
				"FAILED",
				"Cancelled by user",
			);
		}

		return { success: true };
	});
