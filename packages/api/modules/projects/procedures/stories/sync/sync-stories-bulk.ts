import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { READ_ONLY_MODE_ERROR_CODE, READ_ONLY_MODE_MESSAGE } from "@repo/utils";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { resolvePmTarget } from "../../../lib/resolve-pm-target";

/**
 * AUTHORIZATION: Uses canEditProject() - only project admins (owner/editor) can bulk sync
 * Regular members (viewers) can only sync individual stories via the sync endpoint
 */
export const syncStoriesBulkProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/sync-bulk",
		tags: ["Projects", "Stories", "Sync"],
		summary: "Start bulk sync workflow (admin only)",
		description:
			"Start a Temporal workflow to sync stories to the configured PM tool. Only project owners and editors can bulk sync. Viewers can only sync individual stories.",
	})
	.input(
		z
			.object({
				projectId: z.string(),
				organizationId: z.string().nullable().optional(),
				storyIds: z.array(z.string()).optional(),
				unsyncedOnly: z.boolean().optional().default(true),
				statusIds: z.array(z.string()).optional(), // Filter by kanban column status IDs
				direction: z.enum(["push", "pull"]).optional().default("push"),
				/** Pull only: restrict import to these specific PM external IDs (selective pull) */
				pmExternalIds: z.array(z.string()).optional(),
			})
			.refine(
				(data) =>
					!data.pmExternalIds ||
					!data.pmExternalIds.length ||
					data.direction === "pull",
				{
					message:
						"pmExternalIds can only be used with direction 'pull'",
					path: ["pmExternalIds"],
				},
			),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// Get project with PM settings
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				id: true,
				organizationId: true,
				readOnlyMode: true,
				projectManagementMcpServerId: true,
				projectManagementMcpConfigId: true,
				projectManagementContainerId: true,
				projectManagementContainerName: true,
				projectManagementAdditionalContext: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// Read-only mode: bulk push is a direct, user-initiated
		// external write. Bulk pull (reading from the PM tool) stays allowed.
		if (input.direction === "push" && project.readOnlyMode) {
			throw new ORPCError("CONFLICT", {
				message: READ_ONLY_MODE_MESSAGE,
				data: { errorCode: READ_ONLY_MODE_ERROR_CODE },
			});
		}

		if (!project.projectManagementContainerId) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Select a board in Project Settings to sync stories with your PM tool.",
			});
		}

		// Resolve the dispatch target for this project + caller. Accepts both
		// MCP-backed projects and REST-GitLab fallback projects (gitlab-official
		// server + active WorkflowIntegration, no MCPConfig).
		const target = await resolvePmTarget({
			project: {
				projectManagementMcpServerId:
					project.projectManagementMcpServerId,
				projectManagementMcpConfigId:
					project.projectManagementMcpConfigId,
				organizationId: project.organizationId,
			},
			userId: user.id,
			organizationId: project.organizationId,
		});

		if (!target) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Connect a project management tool in Integrations, then select it in Project Settings → Project Management.",
			});
		}

		// Start Temporal workflow
		try {
			const { getTemporalClient } = await import("@repo/temporal");
			const client = await getTemporalClient();

			const additionalContext =
				project.projectManagementAdditionalContext as Record<
					string,
					string
				> | null;

			const workflowId = `story-sync-${input.projectId}-${Date.now()}`;

			// Use string workflow name to avoid minification issues in production builds
			// SECURITY: Pass the current user's MCP config ID, not the admin's
			const handle = await client.workflow.start(
				"storySyncWorkflow",
				withCorrelationMemo({
					taskQueue: "ai-chat",
					workflowId,
					args: [
						{
							projectId: input.projectId,
							// `resolvePmTarget` only returns non-null when the
							// project has a server id (MCP path requires it via
							// resolvePMConfigForUser; REST path checks the
							// server key explicitly).
							mcpServerId:
								// biome-ignore lint/style/noNonNullAssertion: guarded by resolvePmTarget contract above
								project.projectManagementMcpServerId!,
							// T10 widens StorySyncWorkflowInput.mcpConfigId to
							// `string | null` to match the REST-GitLab path
							// (which has no MCPConfig). The string-name form of
							// `client.workflow.start` does not type-check the
							// args payload, so no `@ts-expect-error` is needed.
							mcpConfigId:
								target.kind === "mcp"
									? target.mcpConfigId
									: null,
							containerId: project.projectManagementContainerId,
							containerName:
								project.projectManagementContainerName ??
								undefined,
							additionalContext: additionalContext ?? undefined,
							userId: user.id,
							organizationId: project.organizationId || undefined,
							storyIds: input.storyIds,
							statusIds: input.statusIds, // Filter by kanban column status IDs
							unsyncedOnly: input.unsyncedOnly,
							direction: input.direction,
							pmExternalIds: input.pmExternalIds,
							enableTypeMapping:
								process.env.FEATURE_PM_TYPE_MAPPING === "true",
						},
					],
				}),
			);

			// Activate ADO state polling on first sync (non-blocking)
			db.project
				.update({
					where: { id: input.projectId },
					data: { adoStatePollActive: true },
				})
				.catch((err) =>
					logger.warn("Failed to activate ADO state polling", {
						projectId: input.projectId,
						error: err instanceof Error ? err.message : String(err),
					}),
				);

			return {
				workflowId: handle.workflowId,
				status: "started",
				message: "Sync workflow started",
			};
		} catch (err) {
			const message =
				err instanceof Error
					? err.message
					: "Failed to start sync workflow";
			// Return user-friendly error instead of generic "Internal server error"
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					message.includes("UNAVAILABLE") ||
					message.includes("connection") ||
					message.includes("connect")
						? "Sync service is temporarily unavailable. Please try again in a moment."
						: `Failed to start sync: ${message}`,
			});
		}
	});
