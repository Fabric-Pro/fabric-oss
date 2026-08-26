import { ORPCError } from "@orpc/client";
import { restoreProject } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Restore a soft-deleted project
 *
 * AUTHORIZATION: Only the project OWNER can restore a project.
 * - Personal projects: User must be the owner
 * - Org projects: User must be org member AND project owner
 *
 * The project will be:
 * - Unmarked as deleted (deletedAt cleared)
 * - Visible in normal listings again
 * - No longer scheduled for permanent deletion
 */
export const restoreProjectProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_DELETE, {
			projectIdKey: "id",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/:id/restore",
		tags: ["Projects"],
		summary: "Restore soft-deleted project",
		description:
			"Restore a soft-deleted project before it is permanently deleted. Only the project owner can restore.",
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
		// Restore is gated by PROJECT_DELETE (inverse of delete), so only
		// OWNER passes — matching the prior owner-only semantics.

		try {
			// Restore the project (clears deletedAt and related fields)
			await restoreProject(input.id, user.id, organizationId);

			return { success: true, restored: true };
		} catch (error) {
			// Distinguish between "not restorable" (Prisma P2025 - record not found)
			// and unexpected DB/runtime errors
			const isPrismaNotFound =
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "P2025";

			if (isPrismaNotFound) {
				// Project doesn't exist or isn't in deleted state
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Project is not in a deleted state or could not be restored",
				});
			}

			// Re-throw unexpected errors for proper error handling/alerting
			throw error;
		}
	});
