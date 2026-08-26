import { listFrames } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	conversationId: z.string().optional(),
	limit: z.number().int().positive().optional(),
	offset: z.number().int().min(0).optional(),
});

export const listFramesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/frames",
		tags: ["Frames"],
		summary: "List frames",
		description: "List first-class Fabric Frames for the current tenant",
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const frames = await listFrames({
			...input,
			userId: context.user.id,
			organizationId,
		});
		return frames.map((frame) => ({
			...frame,
			createdAt: frame.createdAt.toISOString(),
			updatedAt: frame.updatedAt.toISOString(),
		}));
	});
