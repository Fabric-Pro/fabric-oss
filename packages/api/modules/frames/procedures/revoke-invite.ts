import { revokeFrameSharing } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { frameRevisionSchema } from "../lib/frame-edit-contract";
import { frameEditErrors } from "../lib/frame-edit-errors";

const inputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
	expectedUpdatedAt: frameRevisionSchema.optional(),
	email: z.string().email(),
});

const outputSchema = z.object({
	success: z.boolean(),
	updatedAt: z.string().optional(),
	error: z.string().optional(),
});

/**
 * Revoke email invitation for a frame
 *
 * Removes a specific email from the frame's sharing grants.
 */
export const revokeFrameInviteProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_DELETE))
	.use(frameEditErrors)
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

		const result = await revokeFrameSharing({
			frameId: input.id,
			userId: context.user.id,
			organizationId,
			mode: "invitation",
			email: input.email,
			expectedUpdatedAt: input.expectedUpdatedAt
				? new Date(input.expectedUpdatedAt)
				: undefined,
		});
		if (!result.ok) {
			return { success: false, error: result.message };
		}
		return { success: true, updatedAt: result.updatedAt.toISOString() };
	});
