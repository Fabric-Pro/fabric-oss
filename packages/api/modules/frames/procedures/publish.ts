import { publishFrame } from "@repo/database";
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

export const publishFrameProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/frames/{id}/publish",
		tags: ["Frames"],
		summary: "Publish a frame",
		description: "Make a first-class Fabric Frame publicly shareable",
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const frame = await publishFrame({
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
