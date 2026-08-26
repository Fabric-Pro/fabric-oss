import { ORPCError } from "@orpc/server";
import { validateMemoryFile, writeMemoryFile } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const writeFileInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	agentInstanceId: z.string(),
	path: z.string(),
	content: z.string(),
	isEnabled: z.boolean().optional(),
	sourceSkillId: z.string().optional(),
});

export const writeFileProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_MEMORY_MANAGE))
	.route({
		method: "POST",
		path: "/agent-memory/file",
		tags: ["Agent Memory"],
		summary: "Create or update a memory file",
	})
	.input(writeFileInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Validate the file content
		const validation = validateMemoryFile(input.path, input.content);
		if (!validation.valid) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Invalid file content: ${validation.error}`,
			});
		}

		const memoryContext = {
			agentInstanceId: input.agentInstanceId,
			userId: context.user.id,
			organizationId,
		};

		const { file, created } = await writeMemoryFile(
			memoryContext,
			input.path,
			input.content,
			"user",
			{ isEnabled: input.isEnabled, sourceSkillId: input.sourceSkillId },
		);

		return {
			file,
			created,
		};
	});
