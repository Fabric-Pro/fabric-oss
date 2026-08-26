import { deleteFrame } from "@repo/database";
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

export const deleteFrameProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_DELETE))
	.route({
		method: "DELETE",
		path: "/frames/{id}",
		tags: ["Frames"],
		summary: "Delete a frame",
		description: "Delete a first-class Fabric Frame by ID",
	})
	.input(inputSchema)
	.output(
		z.object({
			success: z.boolean(),
			error: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const result = await deleteFrame({
			id: input.id,
			userId: context.user.id,
			organizationId,
		});

		if (!result.success) {
			throw new Error(result.error || "Failed to delete frame");
		}

		return { success: true };
	});
