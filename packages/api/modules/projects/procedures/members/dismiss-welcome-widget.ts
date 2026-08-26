import { ORPCError } from "@orpc/client";
import {
	dismissInviteWelcomeWidget,
	getUserPendingInviteForProject,
	getUserRecentMemberForProject,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	protectedProcedure,
	resolveOrganizationId,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: protectedProcedure (no project-permission gate) — like
 * accept/decline, this is an invitee self-service action. We never trust the
 * bare projectId: the handler first verifies the caller has an in-scope PENDING
 * invite to that project (email match + XOR tenant scope), or — failing that —
 * a recent membership in that project, before writing the dismissal preference,
 * and derives the preference's organizationId from the verified project.
 * Exempted in permission-coverage.
 */
export const dismissWelcomeWidgetProcedure = protectedProcedure
	.route({
		method: "POST",
		path: "/projects/invitations/welcome-widget/dismiss",
		tags: ["Projects", "Members"],
		summary: "Dismiss project invitation welcome widget",
		description:
			"Persistently dismiss the welcome widget for a pending project invitation (per user, per project).",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const invite = await getUserPendingInviteForProject(
			user.email,
			user.id,
			input.projectId,
			organizationId,
		);
		const member = invite
			? null
			: await getUserRecentMemberForProject(
					user.id,
					input.projectId,
					organizationId,
				);

		if (!invite && !member) {
			throw new ORPCError("NOT_FOUND", {
				message:
					"No pending invitation or recent membership found for this project",
			});
		}

		const projectOrganizationId =
			invite?.projectOrganizationId ??
			member?.projectOrganizationId ??
			null;

		await dismissInviteWelcomeWidget({
			projectId: input.projectId,
			userId: user.id,
			organizationId: projectOrganizationId,
			// Invite dismissal → set the watermark to the invite's expiresAt (keeps
			// the re-invite resurface rule). Member-only dismissal → `invite?.expiresAt`
			// is undefined, so the helper omits the field and the existing invite
			// watermark is preserved (member hiding keys off inviteWidgetDismissedAt
			// alone).
			dismissedInviteExpiry: invite?.expiresAt,
		});

		recordAuditFromRequest(context, {
			action: "project.invitation.widget_dismissed",
			category: "project",
			organizationId: projectOrganizationId ?? undefined,
			projectId: input.projectId,
			resource: {
				type: "invitation",
				// Member-only dismissals have no invite id; fall back to the project id.
				id: invite?.id ?? input.projectId,
				// The invitee identifier, matching invite-member's audit rows
				// (which use the invited email). The dismisser IS the invitee.
				name: user.email,
			},
		});

		return { success: true as const };
	});
