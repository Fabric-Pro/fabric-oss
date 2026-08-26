import { ORPCError } from "@orpc/client";
import { db, resolvePMConfigForUser } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

/**
 * Render the body a candidate mapping would produce for one real work item.
 *
 * Fronts `composePmFieldPreview`, which delegates to the same
 * `assembleFieldMappingDescription` the sync path uses — so what the admin sees
 * here is what a sync would actually write, not a UI approximation of it.
 */
export const composeFieldPreviewProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_UPDATE, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/{projectId}/pm-fields/compose-preview",
		tags: ["Projects", "Stories", "Sync"],
		summary: "Preview the content a field mapping would produce",
		description:
			"Compose a real work item's values through a candidate field mapping and return the exact markdown an inbound sync would store",
	})
	.input(
		z.object({
			projectId: z.string().min(1),
			workItemId: z.union([z.string().min(1), z.number()]),
			fields: z
				.array(
					z.object({
						id: z.string().min(1),
						displayName: z.string().min(1),
					}),
				)
				.max(50),
		}),
	)
	.output(
		z.object({
			markdown: z.string(),
			emptyFieldIds: z.array(z.string()),
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

		const containerId = project.projectManagementContainerId;
		if (!containerId) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Select a board in Project Settings before previewing PM fields.",
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

		const { composePmFieldPreview } = await import("@repo/temporal");

		try {
			return await composePmFieldPreview({
				mcpConfigId: userMcpConfig.id,
				containerId,
				containerName:
					project.projectManagementContainerName ?? undefined,
				workItemId: input.workItemId,
				fields: input.fields,
				userId: user.id,
				organizationId: project.organizationId || undefined,
			});
		} catch (error) {
			const isNotFound =
				typeof error === "object" &&
				error !== null &&
				"type" in error &&
				(error as { type?: unknown }).type === "TICKET_NOT_FOUND";
			if (isNotFound) {
				throw new ORPCError("NOT_FOUND", {
					message: `Couldn't load ticket #${input.workItemId}. Check the number and your access.`,
				});
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					error instanceof Error
						? error.message
						: "Failed to compose the mapping preview",
			});
		}
	});
