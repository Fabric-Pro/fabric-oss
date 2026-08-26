import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { sendEmail } from "@repo/mail";
import { getBaseUrl } from "@repo/utils";
import { z } from "zod";
import { checkRateLimit } from "../../../../lib/rate-limit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses tenantProtectedProcedure + resolveOrganizationId
 * Owner-only: resend a pending project invitation email.
 */
export const resendProjectInvitationProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_MEMBERS_MANAGE))
	.route({
		method: "POST",
		path: "/projects/:projectId/members/invitations/:invitationId/resend",
		tags: ["Projects", "Members"],
		summary: "Resend project invitation",
		description: "Resend a pending project invitation email (owner only)",
	})
	.input(
		z.object({
			projectId: z.string(),
			invitationId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		const invitation = await db.projectInvitation.findUnique({
			where: { id: input.invitationId },
		});

		if (
			!invitation ||
			invitation.projectId !== input.projectId ||
			invitation.status !== "PENDING"
		) {
			throw new ORPCError("NOT_FOUND", {
				message: "Invitation not found or is no longer pending",
			});
		}

		const rateLimitResult = await checkRateLimit(
			`resend-invite:project:${input.projectId}:${invitation.email}`,
			1,
			60_000,
		);

		if (!rateLimitResult.allowed) {
			if (rateLimitResult.statusCode === 503) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message: "Rate limit service temporarily unavailable",
				});
			}
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message: `Please wait ${rateLimitResult.resetInSeconds} seconds before resending this invitation`,
			});
		}

		await db.projectInvitation.update({
			where: { id: input.invitationId },
			data: { expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
		});

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				name: true,
				organization: { select: { slug: true } },
			},
		});

		const baseUrl = getBaseUrl();
		const orgSlug = project?.organization?.slug;
		const invitationUrl = orgSlug
			? `${baseUrl}/app/${orgSlug}/invitations`
			: `${baseUrl}/app/invitations`;

		await sendEmail({
			to: invitation.email,
			templateId: "projectInvitation",
			context: {
				url: invitationUrl,
				projectName: project?.name ?? "Unknown Project",
				inviterName: user.name || user.email,
				role:
					invitation.role.charAt(0) +
					invitation.role.slice(1).toLowerCase(),
			},
		});

		return { success: true };
	});
