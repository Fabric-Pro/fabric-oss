import { shareFrame } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
	emails: z
		.array(z.string().email())
		.min(1, "At least one email is required")
		.max(50, "Maximum 50 emails allowed"),
});

const outputSchema = z.object({
	success: z.boolean(),
	grants: z
		.array(
			z.object({
				id: z.string(),
				email: z.string().nullable(),
				invitedAt: z.string(),
			}),
		)
		.optional(),
	error: z.string().optional(),
});

/**
 * Invite users by email to access a frame
 *
 * Adds email-based sharing grants for the frame.
 * The frame's share scope must be EMAILS_ONLY or WORKSPACE_AND_EMAILS, and each
 * address must be on a domain the organization allows. `shareFrame` owns both
 * rules, the same command the Fabric Agent's `fabric_share_frame` calls.
 */
export const inviteFrameByEmailProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/frames/{id}/invite",
		tags: ["Frames"],
		summary: "Invite users by email",
		description: "Grant email-based access to a frame",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const result = await shareFrame({
			frameId: input.id,
			userId: context.user.id,
			organizationId,
			emails: input.emails,
		});

		if (!result.ok) {
			return { success: false, error: result.message };
		}

		return {
			success: true,
			grants: result.grants.map((g) => ({
				id: g.id,
				email: g.email,
				invitedAt: g.invitedAt.toISOString(),
			})),
		};
	});
