import { type AgentMemoryFileType, searchMemoryFiles } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const searchFilesInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	agentInstanceId: z.string(),
	query: z.string().min(1),
	fileTypes: z
		.array(
			z.enum([
				"AGENTS_MD",
				"MCP_JSON",
				"SKILL",
				"KNOWLEDGE",
				"CONVERSATION",
				"CUSTOM",
			]),
		)
		.optional(),
	limit: z.number().min(1).max(50).default(20),
});

export const searchFilesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_MEMORY_READ))
	.route({
		method: "POST",
		path: "/agent-memory/search",
		tags: ["Agent Memory"],
		summary: "Search memory files by content",
	})
	.input(searchFilesInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const files = await searchMemoryFiles(
			{
				agentInstanceId: input.agentInstanceId,
				userId: context.user.id,
				organizationId,
			},
			input.query,
			{
				fileTypes: input.fileTypes as AgentMemoryFileType[] | undefined,
				limit: input.limit,
			},
		);

		return { files };
	});
