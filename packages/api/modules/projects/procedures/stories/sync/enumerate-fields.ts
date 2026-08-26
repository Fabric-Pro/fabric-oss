import { ORPCError } from "@orpc/client";
import { db, resolvePMConfigForUser } from "@repo/database";
import { pmServerKeyToDetectedType } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import {
	type AdoConfigForTypes,
	fetchAdoWorkItemTypes,
	isAzureDevOpsConfig,
} from "./ado-work-item-types";

/**
 * Enumerate the deduped catalog of PM fields (standard + custom) a project admin
 * can map into Fabric's inbound content.
 *
 * ADO-only this iteration: the procedure resolves the project's work item type
 * names via the ADO REST list-types path (the MCP server exposes no list-types
 * tool), then fronts the MCP-native `enumeratePmFields` activity which unions
 * `wit_get_work_item_type().fields[]` across those types. Non-ADO providers
 * surface `{ unsupported: true, provider }` so the panel can render the "not
 * available yet" placeholder.
 */
const fieldCatalogEntrySchema = z.object({
	referenceName: z.string(),
	name: z.string(),
	isPlumbing: z.boolean(),
});

export const enumerateFieldsProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_UPDATE, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/projects/{projectId}/pm-fields",
		tags: ["Projects", "Stories", "Sync"],
		summary: "Enumerate PM fields for read-mapping",
		description:
			"Enumerate the union of Azure DevOps fields across the project's work item types so an admin can pick which are aggregated into Fabric content",
	})
	.input(
		z.object({
			projectId: z.string().min(1),
		}),
	)
	.output(
		z.union([
			z.object({
				unsupported: z.literal(true),
				provider: z.string().nullable(),
			}),
			z.object({
				fields: z.array(fieldCatalogEntrySchema),
				workItemTypeCount: z.number(),
			}),
		]),
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

		const containerId = project.projectManagementContainerId;
		if (!containerId) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Select a board in Project Settings before mapping PM fields.",
			});
		}

		const userMcpConfig = await resolvePMConfigForUser({
			configId: project.projectManagementMcpConfigId,
			mcpServerId: project.projectManagementMcpServerId,
			userId: user.id,
			organizationId: project.organizationId || undefined,
		});

		if (!userMcpConfig) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"You have not connected your account to the project management tool.",
			});
		}

		const config = userMcpConfig as AdoConfigForTypes;

		// Non-ADO → surface the unsupported signal (no ADO calls). Provider comes
		// from the stored server key so the panel can name the tool in the copy.
		if (!isAzureDevOpsConfig(config)) {
			return {
				unsupported: true as const,
				provider:
					pmServerKeyToDetectedType(userMcpConfig.mcpServer?.key) ??
					null,
			};
		}

		// Resolve the pickable work item type names (REST — no MCP list-types tool).
		const typesResult = await fetchAdoWorkItemTypes({
			config,
			containerId,
		});
		if (typesResult.error) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: typesResult.error,
			});
		}
		const workItemTypes = typesResult.types.map((t) => t.name);

		const { enumeratePmFields } = await import("@repo/temporal");

		try {
			const result = await enumeratePmFields({
				mcpConfigId: userMcpConfig.id,
				containerId,
				containerName:
					project.projectManagementContainerName ?? undefined,
				workItemTypes,
				userId: user.id,
				organizationId: project.organizationId || undefined,
			});

			if ("unsupported" in result && result.unsupported) {
				return {
					unsupported: true as const,
					provider: result.provider,
				};
			}

			return {
				fields: result.fields,
				workItemTypeCount: result.workItemTypeCount,
			};
		} catch (error) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					error instanceof Error
						? error.message
						: "Failed to enumerate PM fields",
			});
		}
	});
