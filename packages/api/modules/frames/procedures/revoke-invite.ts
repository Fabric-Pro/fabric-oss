import { getFrameById, revokeSharingGrant } from "@repo/database";
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
	email: z.string().email(),
});

const outputSchema = z.object({
	success: z.boolean(),
	error: z.string().optional(),
});

/**
 * Revoke email invitation for a frame
 *
 * Removes a specific email from the frame's sharing grants.
 */
export const revokeFrameInviteProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_DELETE))
	.route({
		method: "POST",
		path: "/frames/{id}/revoke-invite",
		tags: ["Frames"],
		summary: "Revoke email invitation",
		description: "Remove email-based access for a frame",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify the frame exists and user owns it
		const frame = await getFrameById({
			id: input.id,
			userId: context.user.id,
			organizationId,
		});

		if (!frame) {
			return {
				success: false,
				error: "Frame not found",
			};
		}

		// Revoke the grant
		const revoked = await revokeSharingGrant(input.id, input.email);

		if (!revoked) {
			return {
				success: false,
				error: "Email not found in sharing grants",
			};
		}

		return { success: true };
	});
