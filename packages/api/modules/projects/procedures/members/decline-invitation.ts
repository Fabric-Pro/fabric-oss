import { ORPCError } from "@orpc/client";
import { declineProjectInvitation } from "@repo/database";
import { z } from "zod";
import { protectedProcedure } from "../../../../orpc/procedures";

// Uses `protectedProcedure` (not tenant/permission-gated) because the caller
// may be an external guest with no org membership or active tenant context.
// Authorization is enforced by `declineProjectInvitation`, which requires the
// invitation's email to match the authenticated user's email.
// Exempted from permission-coverage.test via the explicit allowlist.
export const declineInvitationProcedure = protectedProcedure
	.route({
		method: "POST",
		path: "/projects/invitations/:invitationId/decline",
		tags: ["Projects", "Members"],
		summary: "Decline project invitation",
		description: "Decline a pending project invitation",
	})
	.input(
		z.object({
			invitationId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		try {
			await declineProjectInvitation(
				input.invitationId,
				context.user.email,
			);
			return { success: true };
		} catch (e) {
			throw new ORPCError("NOT_FOUND", {
				message: "Invitation not found or expired",
			});
		}
	});
