import { ORPCError } from "@orpc/client";
import { db, resolvePMConfigForUser } from "@repo/database";
import { isContainerListingTool } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

/**
 * List teams/boards for an Azure DevOps project.
 * Used to let users choose which board to push work items to.
 * Only works when PM is Azure DevOps and project (container) is selected.
 */
export const listProjectTeamsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/pm-teams",
		tags: ["Projects", "Stories", "Sync"],
		summary: "List ADO teams/boards for project",
		description:
			"List teams (boards) in the configured Azure DevOps project so user can choose which board to push to",
	})
	.input(
		z.object({
			projectId: z.string(),
			/** When configuring, pass the selected container (ADO project) to fetch teams before save */
			containerId: z.string().optional(),
		}),
	)
	.output(
		z.object({
			teams: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
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
				projectManagementContainerName: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		const containerId =
			input.containerId ?? project.projectManagementContainerId;
		if (!containerId) {
			return { teams: [], error: "Project management not configured" };
		}

		const userMcpConfig = await resolvePMConfigForUser({
			configId: project.projectManagementMcpConfigId,
			mcpServerId: project.projectManagementMcpServerId,
			userId: user.id,
			organizationId: project.organizationId || undefined,
		});

		if (!userMcpConfig) {
			return {
				teams: [],
				error: "You have not connected your account to the project management tool",
			};
		}

		// Find the list_project_teams tool
		const { discoverPMToolCapabilities } = await import("@repo/temporal");
		const capabilities = await discoverPMToolCapabilities({
			mcpConfigId: userMcpConfig.id,
			userId: user.id,
			organizationId: project.organizationId || undefined,
		});

		if (!capabilities?.availableTools?.length) {
			return { teams: [], error: "Could not discover PM tools" };
		}

		const listTeamsTool = capabilities.availableTools.find(
			(name) =>
				isContainerListingTool(name) &&
				/project[_-]?teams?/i.test(name),
		);

		if (!listTeamsTool) {
			return {
				teams: [],
				error: "This PM tool does not support listing teams/boards. Only Azure DevOps supports board selection.",
			};
		}

		const { executeMcpTool } = await import("@repo/temporal");

		const result = await executeMcpTool({
			toolName: listTeamsTool,
			args: { project: containerId },
			userId: user.id,
			organizationId: project.organizationId || undefined,
			mcpConfigId: userMcpConfig.id,
		});

		if (!result.success) {
			let errorDetail = "Unknown error";
			if (
				typeof result.output === "object" &&
				result.output !== null &&
				"content" in result.output
			) {
				const content = (
					result.output as {
						content?: Array<{ type?: string; text?: string }>;
					}
				)?.content;
				const textItem = content?.find((c) => c.type === "text");
				if (textItem?.text) {
					errorDetail = textItem.text;
				}
			}
			return { teams: [], error: `Failed to list teams: ${errorDetail}` };
		}

		// Parse response - ADO returns array of team objects
		let raw: unknown = null;
		if (typeof result.output === "object" && result.output !== null) {
			const data = result.output as Record<string, unknown>;
			if (Array.isArray(data.content)) {
				const textItem = (
					data.content as Array<{ type?: string; text?: string }>
				).find((c) => c.type === "text");
				if (textItem?.text) {
					try {
						raw = JSON.parse(textItem.text);
					} catch {
						// ignore
					}
				}
			}
		}

		const teams: Array<{ id: string; name: string }> = [];
		if (Array.isArray(raw)) {
			for (const item of raw) {
				const obj = item as Record<string, unknown>;
				const id = String(obj.id ?? obj.name ?? obj.key ?? "");
				const name = String(
					obj.name ?? obj.displayName ?? obj.id ?? id,
				);
				if (id) {
					teams.push({ id, name });
				}
			}
		} else if (raw && typeof raw === "object" && "value" in raw) {
			const value = (raw as { value: unknown[] }).value;
			if (Array.isArray(value)) {
				for (const item of value) {
					const obj = item as Record<string, unknown>;
					const id = String(obj.id ?? obj.name ?? obj.key ?? "");
					const name = String(
						obj.name ?? obj.displayName ?? obj.id ?? id,
					);
					if (id) {
						teams.push({ id, name });
					}
				}
			}
		}

		return { teams, error: null };
	});
