import { ORPCError } from "@orpc/server";
import { readMemoryFile } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const readFileInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	agentInstanceId: z.string(),
	path: z.string(),
});

export const readFileProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_MEMORY_READ))
	.route({
		method: "GET",
		path: "/agent-memory/file",
		tags: ["Agent Memory"],
		summary: "Read a memory file by path",
	})
	.input(readFileInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const file = await readMemoryFile(
			{
				agentInstanceId: input.agentInstanceId,
				userId: context.user.id,
				organizationId,
			},
			input.path,
		);

		if (!file) {
			throw new ORPCError("NOT_FOUND", {
				message: `File not found: ${input.path}`,
			});
		}

		return { file };
	});
