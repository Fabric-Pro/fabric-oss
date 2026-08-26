import { ORPCError } from "@orpc/client";
import { acceptProjectInvitation } from "@repo/database";
import { z } from "zod";
import { protectedProcedure } from "../../../../orpc/procedures";

// Uses `protectedProcedure` (not tenant/permission-gated) because the caller
// may be an external guest with no org membership or active tenant context.
// Authorization is enforced by `acceptProjectInvitation`, which requires the
// invitation's email to match the authenticated user's email.
// Exempted from permission-coverage.test via the explicit allowlist.
export const acceptInvitationProcedure = protectedProcedure
	.route({
		method: "POST",
		path: "/projects/invitations/:invitationId/accept",
		tags: ["Projects", "Members"],
		summary: "Accept project invitation",
		description: "Accept a pending project invitation",
	})
	.input(
		z.object({
			invitationId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		try {
			// Email verification is enforced by acceptProjectInvitation itself.
			const member = await acceptProjectInvitation(
				input.invitationId,
				user.id,
				user.email,
			);
			return { member };
		} catch (e) {
			throw new ORPCError("NOT_FOUND", {
				message: "Invitation not found or expired",
			});
		}
	});
