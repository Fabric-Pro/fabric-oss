import { ORPCError } from "@orpc/client";
import { db, resolvePMConfigForUser } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

/**
 * Suggest an inbound field mapping from real work items.
 *
 * Fronts the `suggestPmFieldMapping` activity. The admin supplies one
 * representative work item; the activity reads that item and its type's form
 * definition, and returns the fields the form DECLARES as rich-text bodies —
 * labelled as they appear on screen — so the UI can propose a mapping instead of
 * making someone hunt through a several-hundred-row field catalog.
 */
const suggestionSchema = z.object({
	id: z.string(),
	label: z.string(),
	controlType: z.string().optional(),
	isContentControl: z.boolean(),
	populatedOnExample: z.boolean(),
	charCount: z.number(),
	examplePreview: z.string(),
	score: z.number(),
});

/** ApplicationFailure carries the activity's typed reason on `.type`. */
function isTicketNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"type" in error &&
		(error as { type?: unknown }).type === "TICKET_NOT_FOUND"
	);
}

export const suggestFieldMappingProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_UPDATE, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/{projectId}/pm-fields/suggest",
		tags: ["Projects", "Stories", "Sync"],
		summary: "Suggest a PM field mapping from sampled work items",
		description:
			"Read one representative Azure DevOps work item, sample recent items of the same type, and return fields ranked by how consistently they carry content",
	})
	.input(
		z.object({
			projectId: z.string().min(1),
			exampleWorkItemId: z.union([z.string().min(1), z.number()]),
		}),
	)
	.output(
		z.object({
			workItemType: z.string().nullable(),
			source: z.enum(["form", "values"]),
			suggestions: z.array(suggestionSchema),
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
					"Select a board in Project Settings before suggesting PM fields.",
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

		const { suggestPmFieldMapping } = await import("@repo/temporal");

		try {
			const result = await suggestPmFieldMapping({
				mcpConfigId: userMcpConfig.id,
				containerId,
				containerName:
					project.projectManagementContainerName ?? undefined,
				exampleWorkItemId: input.exampleWorkItemId,
				userId: user.id,
				organizationId: project.organizationId || undefined,
			});

			return {
				workItemType: result.workItemType,
				source: result.source,
				suggestions: result.suggestions,
			};
		} catch (error) {
			if (isTicketNotFound(error)) {
				throw new ORPCError("NOT_FOUND", {
					message: `Couldn't load ticket #${input.exampleWorkItemId}. Check the number and your access.`,
				});
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					error instanceof Error
						? error.message
						: "Failed to suggest a field mapping",
			});
		}
	});
