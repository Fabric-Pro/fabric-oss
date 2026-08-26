import { ORPCError } from "@orpc/server";
import { deleteMemoryFile } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const deleteFileInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	agentInstanceId: z.string(),
	path: z.string(),
});

export const deleteFileProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_MEMORY_MANAGE))
	.route({
		method: "DELETE",
		path: "/agent-memory/file",
		tags: ["Agent Memory"],
		summary: "Delete a memory file",
	})
	.input(deleteFileInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const deleted = await deleteMemoryFile(
			{
				agentInstanceId: input.agentInstanceId,
				userId: context.user.id,
				organizationId,
			},
			input.path,
		);

		if (!deleted) {
			throw new ORPCError("NOT_FOUND", {
				message: `File not found: ${input.path}`,
			});
		}

		return { deleted: true };
	});
