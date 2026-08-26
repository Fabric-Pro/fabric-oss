import { getFrameById } from "@repo/database";
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

export const getFrameProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/frames/{id}",
		tags: ["Frames"],
		summary: "Get a frame",
		description: "Get a first-class Fabric Frame by ID",
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const frame = await getFrameById({
			id: input.id,
			userId: context.user.id,
			organizationId,
		});

		if (!frame) {
			throw new Error("Frame not found");
		}

		return {
			...frame,
			createdAt: frame.createdAt.toISOString(),
			updatedAt: frame.updatedAt.toISOString(),
		};
	});
