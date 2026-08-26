/**
 * List Organization Invitations Procedure
 *
 * Returns all invitations for the organization, including inviter details.
 * Joins the user record on inviterId to return inviter name and email.
 * Any org member can view the list.
 *
 * AUTHORIZATION: Requires org membership via requireOrgMembership()
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

export const listOrgInvitationsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_READ))
	.route({
		method: "GET",
		path: "/organizations/{organizationId}/invitations",
		tags: ["Organizations", "Invitations"],
		summary: "List all organization invitations",
		description:
			"Get all invitations for the organization, including inviter details",
	})
	.input(
		z.object({
			organizationId: z.string().min(1, "Organization ID is required"),
		}),
	)
	.output(
		z.array(
			z.object({
				id: z.string(),
				email: z.string(),
				role: z.string().nullable(),
				status: z.string(),
				expiresAt: z.date(),
				inviterId: z.string(),
				inviterName: z.string().nullable(),
				inviterEmail: z.string().nullable(),
			}),
		),
	)
	.handler(async ({ context: { user, session }, input }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		if (!organizationId) {
			throw new ORPCError("FORBIDDEN", {
				message: "You must be a member of this organization",
			});
		}

		const membership = await requireOrgMembership(user.id, organizationId);

		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You must be a member of this organization",
			});
		}

		const invitations = await db.invitation.findMany({
			where: { organizationId },
			include: {
				user: {
					select: {
						id: true,
						name: true,
						email: true,
					},
				},
			},
			orderBy: { expiresAt: "asc" },
		});

		return invitations.map((invitation) => ({
			id: invitation.id,
			email: invitation.email,
			role: invitation.role ?? null,
			status: invitation.status,
			expiresAt: invitation.expiresAt,
			inviterId: invitation.inviterId,
			inviterName: invitation.user?.name ?? null,
			inviterEmail: invitation.user?.email ?? null,
		}));
	});
