import { ORPCError } from "@orpc/client";
import { db, resolvePMConfigForUser } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

/**
 * Preview a real work item's live field values.
 *
 * Fronts the on-demand `previewPmFieldValues` activity so an admin can enter a
 * ticket number and empirically see which candidate fields carry content vs. are
 * empty (ADO exposes no data-type on the field object). Not cached. The activity
 * echoes `id` for `displayName`; the frontend substitutes the friendly catalog
 * name it already holds.
 */
const previewFieldSchema = z.object({
	id: z.string(),
	displayName: z.string(),
	value: z.string().nullable(),
	isEmpty: z.boolean(),
	renderedPreview: z.string(),
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

export const previewTicketFieldsProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_UPDATE, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/{projectId}/pm-fields/preview",
		tags: ["Projects", "Stories", "Sync"],
		summary: "Preview a work item's PM field values",
		description:
			"Live-fetch one Azure DevOps work item and return each requested field's value + rendered preview so an admin can distinguish content-bearing fields",
	})
	.input(
		z.object({
			projectId: z.string().min(1),
			workItemId: z.union([z.string().min(1), z.number()]),
			/** When omitted, the activity returns a default content-candidate set. */
			fieldIds: z.array(z.string()).optional(),
		}),
	)
	.output(
		z.object({
			fields: z.array(previewFieldSchema),
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

		const { previewPmFieldValues } = await import("@repo/temporal");

		try {
			const result = await previewPmFieldValues({
				mcpConfigId: userMcpConfig.id,
				containerId,
				containerName:
					project.projectManagementContainerName ?? undefined,
				workItemId: input.workItemId,
				fieldIds: input.fieldIds,
				userId: user.id,
				organizationId: project.organizationId || undefined,
			});

			return { fields: result.fields };
		} catch (error) {
			if (isTicketNotFound(error)) {
				throw new ORPCError("NOT_FOUND", {
					message: `Couldn't load ticket #${input.workItemId}. Check the number and your access.`,
				});
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					error instanceof Error
						? error.message
						: "Failed to load ticket field values",
			});
		}
	});
