import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses tenantProtectedProcedure + resolveOrganizationId
 * Owner-only: hard-delete a pending project invitation.
 */
export const revokeProjectInvitationProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_MEMBERS_MANAGE))
	.route({
		method: "DELETE",
		path: "/projects/:projectId/members/invitations/:invitationId",
		tags: ["Projects", "Members"],
		summary: "Revoke project invitation",
		description: "Delete a pending project invitation (owner only)",
	})
	.input(
		z.object({
			projectId: z.string(),
			invitationId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		const invitation = await db.projectInvitation.findUnique({
			where: { id: input.invitationId },
		});

		if (!invitation || invitation.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Invitation not found",
			});
		}

		await db.projectInvitation.delete({
			where: { id: input.invitationId },
		});

		return { success: true };
	});
