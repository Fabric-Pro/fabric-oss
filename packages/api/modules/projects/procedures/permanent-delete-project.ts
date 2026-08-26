import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { getTemporalClient, isTemporalAvailable } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Permanently delete a soft-deleted project
 *
 * AUTHORIZATION: Only the project OWNER can permanently delete a project.
 * - Personal projects: User must be the owner
 * - Org projects: User must be org member AND project owner
 *
 * This action is irreversible. The project and all its data will be permanently removed:
 * - All Qdrant vectors (project contexts)
 * - All database records (project, documents, contexts via cascade)
 *
 * A Temporal workflow handles the deletion for durability.
 */
export const permanentDeleteProjectProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_DELETE, {
			projectIdKey: "id",
		}),
	)
	.route({
		method: "DELETE",
		path: "/projects/:id/permanent",
		tags: ["Projects"],
		summary: "Permanently delete project",
		description:
			"Permanently delete a soft-deleted project. This is irreversible. Only the project owner can permanently delete.",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Authorization is enforced by `requireProjectPermission` above.
		// PROJECT_DELETE is granted only to OWNER.

		// Verify project is in deleted state (only soft-deleted projects can be permanently deleted)
		const project = await db.project.findFirst({
			where: {
				id: input.id,
				deletedAt: { not: null },
			},
			select: { id: true, name: true },
		});

		if (!project) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Project is not in a deleted state. Please soft delete it first.",
			});
		}

		// Check if Temporal is available
		const temporalAvailable = await isTemporalAvailable();

		if (!temporalAvailable) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message:
					"Workflow service is unavailable. Please try again later.",
			});
		}

		// Start the permanent delete workflow
		const client = await getTemporalClient();

		const handle = await client.workflow.start(
			"projectPermanentDeleteWorkflow",
			withCorrelationMemo({
				taskQueue: "fabric-worker",
				workflowId: `project-permanent-delete-${input.id}-${Date.now()}`,
				args: [
					{
						projectId: input.id,
						userId: user.id,
						organizationId,
					},
				],
			}),
		);

		return {
			success: true,
			workflowId: handle.workflowId,
			projectId: input.id,
			message: "Project permanent deletion has been initiated",
		};
	});
