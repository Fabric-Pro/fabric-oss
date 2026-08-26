import { revokeFrameShare } from "@repo/database";
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
});

export const revokeFrameShareProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_DELETE))
	.route({
		method: "POST",
		path: "/frames/{id}/revoke-share",
		tags: ["Frames"],
		summary: "Revoke frame share",
		description: "Disable public sharing for a Frame",
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const frame = await revokeFrameShare({
			...input,
			userId: context.user.id,
			organizationId,
		});
		if (!frame) {
			throw new Error("Frame not found");
		}
		return {
			id: frame.id,
			shareToken: frame.shareToken,
			isPublic: frame.isPublic,
		};
	});
