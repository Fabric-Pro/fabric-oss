/**
 * Resend Organization Invitation Procedure
 *
 * Resends the invitation email to a pending invitee and extends expiresAt by 7 days.
 * Enforces a rate limit of 1 request per 60 seconds per (organizationId, email) pair.
 *
 * AUTHORIZATION: Requires org owner or admin role via requireOrgMembership()
 */

import { ORPCError } from "@orpc/server";
import { db, getUserByEmail } from "@repo/database";
import { sendEmail } from "@repo/mail";
import { getBaseUrl } from "@repo/utils";
import { z } from "zod";
import { checkRateLimit } from "../../../../lib/rate-limit";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../lib/membership";

export const resendOrgInvitationProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_UPDATE))
	.route({
		method: "POST",
		path: "/organizations/{organizationId}/invitations/{invitationId}/resend",
		tags: ["Organizations", "Invitations"],
		summary: "Resend an organization invitation",
		description:
			"Resends the invitation email and extends the expiry date by 7 days",
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
					"Only organization owners and admins can resend invitations",
			});
		}

		const membership = await requireOrgMembership(user.id, organizationId, [
			"owner",
			"admin",
		]);

		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only organization owners and admins can resend invitations",
			});
		}

		const invitation = await db.invitation.findUnique({
			where: { id: input.invitationId },
		});

		if (
			!invitation ||
			invitation.organizationId !== organizationId ||
			invitation.status !== "pending"
		) {
			throw new ORPCError("NOT_FOUND", {
				message: "Pending invitation not found",
			});
		}

		const rl = await checkRateLimit(
			`resend-invite:org:${organizationId}:${invitation.email}`,
			1,
			60_000,
		);

		if (!rl.allowed) {
			if (rl.statusCode === 503) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message: "Rate limit service temporarily unavailable",
				});
			}
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message: `Please wait ${rl.resetInSeconds} seconds before resending to this address.`,
			});
		}

		await db.invitation.update({
			where: { id: input.invitationId },
			data: { expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
		});

		const existingUser = await getUserByEmail(invitation.email);
		const url = new URL(
			existingUser ? "/auth/login" : "/auth/signup",
			getBaseUrl(),
		);
		url.searchParams.set("invitationId", invitation.id);
		url.searchParams.set("email", invitation.email);

		await sendEmail({
			to: invitation.email,
			templateId: "organizationInvitation",
			context: {
				organizationName: membership.organization.name,
				url: url.toString(),
			},
		});

		return { success: true };
	});
