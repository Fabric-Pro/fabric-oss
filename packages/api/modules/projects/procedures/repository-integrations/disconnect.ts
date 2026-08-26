/**
 * Disconnect Repository Integration
 *
 * Removes a project-level repository integration.
 * PROJECT_ADMIN+ (via PROJECT_SETTINGS_EDIT). Does NOT delete previously
 * extracted ProjectContext entries.
 */

import { ORPCError } from "@orpc/client";
import {
	cleanupCodeSearchOnRepoUnlink,
	deleteProjectRepoIntegration,
	getProjectRepoIntegration,
	logRepoIntegrationActivity,
	syncLegacyProjectRepoOnDisconnect,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { cancelCodeIndexingForRepo } from "../../lib/code-indexing-trigger";

export const disconnectRepoIntegrationProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "DELETE",
		path: "/projects/:projectId/repository-integrations/:integrationId",
		tags: ["Projects", "Repository Integrations"],
		summary: "Disconnect a repository integration",
	})
	.input(
		z.object({
			projectId: z.string(),
			integrationId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Get integration details for audit log before deleting
		const integration = await getProjectRepoIntegration(
			input.integrationId,
			input.projectId,
		);
		if (!integration) {
			throw new ORPCError("NOT_FOUND", {
				message: "Repository integration not found",
			});
		}

		await deleteProjectRepoIntegration(
			input.integrationId,
			input.projectId,
		);

		// Step 1: Cancel this repo's in-flight code indexing BEFORE destructive
		// cleanup, so the workflow can't upsert vectors after we delete them.
		await cancelCodeIndexingForRepo({
			projectId: input.projectId,
			repositoryIntegrationId: input.integrationId,
		});

		// Step 2: Now safe to delete DB rows and vectors
		const { deletedContextQdrantIds, organizationId: contextOrgId } =
			await cleanupCodeSearchOnRepoUnlink(
				input.projectId,
				integration.repositoryUrl,
			);

		// Step 3: Delete Qdrant vectors (CODE_ANALYSIS via workflow, CODE_FILE directly)
		try {
			const { getTemporalClient } = await import("@repo/temporal");
			const client = await getTemporalClient();

			for (const ctx of deletedContextQdrantIds) {
				await client.workflow.start(
					"contextDeletionWorkflow",
					withCorrelationMemo({
						taskQueue: "project-documents",
						workflowId: `ctx-delete-${ctx.id}`,
						args: [
							{
								contextId: ctx.id,
								projectId: input.projectId,
								userId: user.id,
								organizationId: contextOrgId ?? undefined,
								qdrantId: ctx.qdrantId,
							},
						],
					}),
				);
			}
		} catch (error) {
			console.error(
				"[disconnect] Failed to start cleanup workflow:",
				error,
			);
		}

		try {
			const { deleteProjectCodeIndexVectors } = await import("@repo/rag");
			const { deleteProjectCodeIndex } = await import("@repo/database");
			// Scope teardown to the disconnected repo only — other connected
			// repos keep their indexes.
			await deleteProjectCodeIndexVectors(
				input.projectId,
				contextOrgId,
				input.integrationId,
			);
			await deleteProjectCodeIndex(input.projectId, input.integrationId);
		} catch (error) {
			console.error(
				"[disconnect] Failed to delete code index vectors:",
				error,
			);
		}

		await syncLegacyProjectRepoOnDisconnect(
			input.projectId,
			integration.repositoryUrl,
		);

		await logRepoIntegrationActivity({
			projectId: input.projectId,
			userId: user.id,
			userName: user.name || "Unknown",
			organizationId,
			activityType: "repo_integration_removed",
			integrationId: input.integrationId,
			repositoryName: `${integration.repositoryOwner}/${integration.repositoryName}`,
			metadata: { provider: integration.provider },
		});

		// Audit-log emission. `integration` was fetched at the top
		// of this handler (before the delete) so the snapshot is correct.
		recordAuditFromRequest(context, {
			action: "org.integration.disconnected",
			category: "org",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "repository_integration",
				id: input.integrationId,
				name: `${integration.repositoryOwner}/${integration.repositoryName}`,
			},
			metadata: {
				provider: integration.provider,
			},
		});

		return { success: true };
	});
