import { getInviteWelcomeWidgetData } from "@repo/database";
import { z } from "zod";
import {
	protectedProcedure,
	resolveOrganizationId,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: protectedProcedure (no project-permission gate) — like
 * accept/decline, this is an invitee self-service action on email-addressed
 * invitations. The DB helper filters by the authenticated user's email, so a
 * caller only ever sees their own invitations. Exempted in permission-coverage.
 */
export const getWelcomeWidgetProcedure = protectedProcedure
	.route({
		method: "GET",
		path: "/projects/invitations/welcome-widget",
		tags: ["Projects", "Members"],
		summary: "Get project invitation welcome widget data",
		description:
			"Returns the most-recent pending project invitation and total count for the dashboard welcome widget.",
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
		return await getInviteWelcomeWidgetData(
			user.email,
			user.id,
			organizationId,
		);
	});
