import { ORPCError } from "@orpc/client";
import {
	db,
	getStoryById,
	hasProjectAccess,
	isPmServerIdKeySentinel,
	readPmServerIdKeySentinel,
	resolvePMConfigForUser,
} from "@repo/database";
import { READ_ONLY_MODE_ERROR_CODE, READ_ONLY_MODE_MESSAGE } from "@repo/utils";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { stripInternalStoryFields } from "../../../lib/strip-internal-story-fields";

const SyncDirectionSchema = z.enum(["push", "pull"]);

/**
 * AUTHORIZATION: Uses hasProjectAccess() - all project members (owner/editor/viewer) can sync individual stories
 * This is different from bulk sync which requires admin permissions
 */
export const syncStoryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/sync",
		tags: ["Projects", "Stories", "Sync"],
		summary: "Sync individual story with PM tool",
		description:
			"Push or pull a single story to/from the configured PM tool. Available to all project members.",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			direction: SyncDirectionSchema,
			syncTasks: z.boolean().optional().default(false),
			organizationId: z.string().nullable().optional(),
			/** When true and direction is "push", a PM_TOOL_MISMATCH is
			 *  treated as an explicit migration: the stored link to the
			 *  previous tool is cleared and the push proceeds against
			 *  the active tool. Ignored for direction "pull". */
			overrideMismatch: z.boolean().optional().default(false),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// AUTHORIZATION: All project members (including viewers) can sync individual stories
		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Get project with PM settings
		// IMPORTANT: Include organizationId for tenant isolation
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				id: true,
				organizationId: true, // Required for tenant isolation
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

		// Read-only mode: a direct, user-initiated push is
		// blocked with a typed error the frontend surfaces as a toast.
		// Pull (reading FROM the PM tool) stays allowed.
		if (input.direction === "push" && project.readOnlyMode) {
			throw new ORPCError("CONFLICT", {
				message: READ_ONLY_MODE_MESSAGE,
				data: { errorCode: READ_ONLY_MODE_ERROR_CODE },
			});
		}

		if (!project.projectManagementContainerId) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Project management integration not configured. Go to Settings to configure.",
			});
		}

		// Resolve the CALLING USER's MCP config — prefers configId, falls back to serverId
		const userMcpConfig = await resolvePMConfigForUser({
			configId: project.projectManagementMcpConfigId,
			mcpServerId: project.projectManagementMcpServerId,
			userId: user.id,
			organizationId: project.organizationId || undefined,
		});

		// REST-GitLab fallback: the project's server is `gitlab-official` AND the
		// tenant has an active WorkflowIntegration, but the calling user has no
		// resolvable MCPConfig — either because the tier probe found the GitLab
		// instance isn't MCP-capable (fresh REST projects) or because an older
		// project still carries a stale `projectManagementMcpConfigId` from when
		// GitLab went through MCP. In that case syncStoryToPM dispatches through
		// the REST fallback transparently, so the MCP-only "not connected"/
		// "disabled" guards below must be skipped. Gated on `!userMcpConfig` alone.
		let restGitLab = false;
		if (!userMcpConfig && project.projectManagementMcpServerId) {
			// Resolve the project's PM server key. For a real catalog row we
			// look it up by id; for a `key:` sentinel (PR #1205, seed drift
			// fallback) we read the key directly without touching the DB.
			let serverKey: string | null = null;
			if (isPmServerIdKeySentinel(project.projectManagementMcpServerId)) {
				serverKey = readPmServerIdKeySentinel(
					project.projectManagementMcpServerId,
				);
			} else {
				const server = await db.mCPServer.findUnique({
					where: { id: project.projectManagementMcpServerId },
					select: { key: true },
				});
				serverKey = server?.key ?? null;
			}
			if (serverKey === "gitlab-official") {
				const tenantFilter = project.organizationId
					? {
							organizationId: project.organizationId,
							userId: user.id,
						}
					: { organizationId: null, userId: user.id };
				const integration = await db.workflowIntegration.findFirst({
					where: {
						...tenantFilter,
						provider: "GITLAB",
						isActive: true,
					},
					select: { id: true },
				});
				restGitLab = Boolean(integration);
			}
		}

		if (!restGitLab && !userMcpConfig) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"You have not connected your account to the project management tool. Please configure your MCP connection in Settings.",
			});
		}

		if (!restGitLab && userMcpConfig && !userMcpConfig.enabled) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Your project management connection is disabled. Please enable it in Settings.",
			});
		}

		// Get the story
		const story = await getStoryById(input.storyId, input.projectId);
		if (!story) {
			throw new ORPCError("NOT_FOUND", {
				message: "Story not found",
			});
		}

		// For pull, story must already be synced
		if (input.direction === "pull" && !story.externalId) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Cannot pull: story has not been synced to PM tool yet. Push first.",
			});
		}

		// Import sync functions dynamically to avoid circular deps
		const { syncStoryToPM, syncTaskToPM } = await import("@repo/temporal");

		// Parse additional context
		const additionalContext =
			project.projectManagementAdditionalContext as Record<
				string,
				string
			> | null;

		// Execute sync using the CURRENT USER's MCP config (not the admin's)
		// SECURITY: Each user uses their own credentials
		// REST-GitLab has no MCPConfig; syncStoryToPM resolves the REST path
		// from mcpServerId instead. When not REST-GitLab the guards above
		// guaranteed a non-null userMcpConfig.
		const syncMcpConfigId = restGitLab ? null : (userMcpConfig?.id ?? null);

		const result = await syncStoryToPM({
			storyId: input.storyId,
			projectId: input.projectId,
			mcpConfigId: syncMcpConfigId,
			mcpServerId: project.projectManagementMcpServerId ?? undefined,
			containerId: project.projectManagementContainerId,
			additionalContext: additionalContext ?? undefined,
			direction: input.direction,
			userId: user.id,
			organizationId: project.organizationId || undefined,
			overrideMismatch:
				input.direction === "push" && input.overrideMismatch,
		});

		if (!result.success) {
			if (
				result.errorCode === "PM_TOOL_MISMATCH" ||
				result.errorCode === "EXTERNAL_ID_NOT_FOUND"
			) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						result.error || "Sync blocked due to PM tool mismatch",
					// #1360: surface linkPreserved so the client can show the
					// "link kept" copy for a not-found whose stamped link was
					// intentionally preserved (deletion is owned by the poll).
					data: {
						errorCode: result.errorCode,
						linkPreserved: result.linkPreserved,
					},
				});
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: result.error || "Failed to sync story",
			});
		}

		// Sync tasks if requested and story was pushed successfully
		const taskResults: Array<{
			taskId: string;
			identifier: string;
			success: boolean;
			externalId?: string;
			error?: string;
		}> = [];

		if (
			input.syncTasks &&
			input.direction === "push" &&
			// Task-level sync runs through the MCP path only; the REST-GitLab
			// fallback (mcpConfigId null) is not supported by syncTaskToPM.
			!restGitLab &&
			userMcpConfig &&
			story.tasks.length > 0
		) {
			for (const task of story.tasks) {
				const taskResult = await syncTaskToPM({
					taskId: task.id,
					storyId: input.storyId,
					projectId: input.projectId,
					mcpConfigId: userMcpConfig.id, // Use current user's config
					containerId: project.projectManagementContainerId,
					parentExternalId: result.externalId,
					additionalContext: additionalContext ?? undefined,
					userId: user.id,
					organizationId: project.organizationId || undefined,
				});

				taskResults.push({
					taskId: task.id,
					identifier: task.identifier,
					success: taskResult.success,
					externalId: taskResult.externalId,
					error: taskResult.error,
				});
			}
		}

		// Fetch updated story
		const updatedStory = await getStoryById(input.storyId, input.projectId);

		// Audit-log emission. Only emit `story.pm_pushed` on a
		// real outbound push; the "pull" direction is a remote read into our
		// DB and is intentionally outside the v1 taxonomy.
		if (input.direction === "push") {
			recordAuditFromRequest(context, {
				action: "story.pm_pushed",
				category: "story",
				organizationId,
				projectId: input.projectId,
				resource: {
					type: "story",
					id: input.storyId,
					name: updatedStory?.title ?? null,
				},
				metadata: {
					externalId: result.externalId ?? null,
					externalUrl: result.externalUrl ?? null,
					syncedTasks: taskResults.length,
				},
			});
		}

		return {
			success: true,
			// `updatedStory` is a re-read and can be null (the row may have gone
			// away mid-sync); the pre-existing shape returns it as-is, so keep
			// null rather than inventing an empty object.
			story: updatedStory ? stripInternalStoryFields(updatedStory) : null,
			externalId: result.externalId,
			externalUrl: result.externalUrl,
			direction: input.direction,
			taskResults: taskResults.length > 0 ? taskResults : undefined,
			// #1360: terminal-status lifecycle outcome from the per-item pull
			// reconcile. On push-only syncs these are undefined (the frontend
			// gates lifecycle copy on direction === "pull").
			terminalApplied: result.terminalApplied,
			lifecycleAction: result.lifecycleAction,
			lifecycleReconciled: result.lifecycleReconciled,
			terminalStatusLabel: result.terminalStatusLabel,
		};
	});
