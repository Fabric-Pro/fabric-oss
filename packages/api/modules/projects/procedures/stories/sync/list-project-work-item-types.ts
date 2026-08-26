import { ORPCError } from "@orpc/client";
import { db, resolvePMConfigForUser } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { fetchAdoWorkItemTypes } from "./ado-work-item-types";

/**
 * List work item types for an Azure DevOps project.
 * Uses the Azure DevOps REST API directly with PAT from MCP config (the shared
 * `fetchAdoWorkItemTypes` helper). Only works when PM is Azure DevOps and the
 * project (container) is selected.
 *
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-item-types/list
 */
export const listProjectWorkItemTypesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/pm-work-item-types",
		tags: ["Projects", "Stories", "Sync"],
		summary: "List ADO work item types for project",
		description:
			"List work item types in the configured Azure DevOps project so user can choose which type to create",
	})
	.input(
		z.object({
			projectId: z.string(),
			/** When configuring, pass the selected container (ADO project) to fetch types before save */
			containerId: z.string().optional(),
		}),
	)
	.output(
		z.object({
			workItemTypes: z.array(
				z.object({
					name: z.string(),
					description: z.string().nullable(),
				}),
			),
			error: z.string().nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				id: true,
				organizationId: true,
				projectManagementMcpServerId: true,
				projectManagementMcpConfigId: true,
				projectManagementContainerId: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		const containerId =
			input.containerId ?? project.projectManagementContainerId;
		if (!containerId) {
			return {
				workItemTypes: [],
				error: "Project management not configured",
			};
		}

		const userMcpConfig = await resolvePMConfigForUser({
			configId: project.projectManagementMcpConfigId,
			mcpServerId: project.projectManagementMcpServerId,
			userId: user.id,
			organizationId: project.organizationId || undefined,
		});

		if (!userMcpConfig) {
			return {
				workItemTypes: [],
				error: "You have not connected your account to the project management tool",
			};
		}

		const result = await fetchAdoWorkItemTypes({
			config: userMcpConfig,
			containerId,
		});

		return { workItemTypes: result.types, error: result.error };
	});
