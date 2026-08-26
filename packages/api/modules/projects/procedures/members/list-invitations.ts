import { getUserPendingInvitations } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses tenantProtectedProcedure + resolveOrganizationId
 * for proper tenant-isolated invitation listing.
 *
 * XOR pattern: personal context shows personal project invitations,
 * org context shows org project invitations.
 */
export const listInvitationsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_MEMBERS_READ))
	.route({
		method: "GET",
		path: "/projects/invitations",
		tags: ["Projects", "Members"],
		summary: "List pending project invitations",
		description: "Get all pending project invitations for the current user",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Get pending invitations filtered by tenant context
		const invitations = await getUserPendingInvitations(
			user.email,
			organizationId,
		);

		return { invitations };
	});
