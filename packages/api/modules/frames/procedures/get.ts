import { ORPCError } from "@orpc/client";
import { getAccessibleFrameById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const getFrameProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_READ, {
			requireOrganization: true,
		}),
	)
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
		const frame = organizationId
			? await getAccessibleFrameById({
					id: input.id,
					userId: context.user.id,
					userEmail: context.user.email,
					organizationId,
				})
			: null;

		if (!frame) {
			throw new ORPCError("NOT_FOUND", { message: "Frame not found" });
		}

		return {
			...frame,
			createdAt: frame.createdAt.toISOString(),
			updatedAt: frame.updatedAt.toISOString(),
		};
	});
