/**
 * Cancel Organization Invitation Procedure
 *
 * Hard-deletes the invitation row, allowing the same email address to be
 * re-invited immediately (bypasses the unique constraint left by soft-cancel).
 *
 * AUTHORIZATION: Requires org owner or admin role via requireOrgMembership()
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../lib/membership";

export const cancelOrgInvitationProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_MEMBERS_INVITE))
	.route({
		method: "DELETE",
		path: "/organizations/{organizationId}/invitations/{invitationId}",
		tags: ["Organizations", "Invitations"],
		summary: "Cancel an organization invitation",
		description: "Permanently deletes the invitation row",
	})
	.input(
		z.object({
			invitationId: z.string().min(1, "Invitation ID is required"),
			organizationId: z.string().min(1, "Organization ID is required"),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
		}),
	)
	.handler(async ({ context: { user, session }, input }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		if (!organizationId) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only organization owners and admins can cancel invitations",
			});
		}

		const membership = await requireOrgMembership(user.id, organizationId, [
			"owner",
			"admin",
		]);

		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only organization owners and admins can cancel invitations",
			});
		}

		const invitation = await db.invitation.findUnique({
			where: { id: input.invitationId },
		});

		if (!invitation || invitation.organizationId !== organizationId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Invitation not found",
			});
		}

		await db.invitation.delete({
			where: { id: input.invitationId },
		});

		return { success: true };
	});
