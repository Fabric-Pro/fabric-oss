import { type AgentMemoryFileType, listMemoryFiles } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const listFilesInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	agentInstanceId: z.string(),
	path: z.string().optional(),
	fileType: z
		.enum([
			"AGENTS_MD",
			"MCP_JSON",
			"SKILL",
			"KNOWLEDGE",
			"CONVERSATION",
			"CUSTOM",
		])
		.optional(),
	limit: z.number().min(1).max(100).default(100),
	offset: z.number().min(0).default(0),
});

export const listFilesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_MEMORY_READ))
	.route({
		method: "GET",
		path: "/agent-memory/files",
		tags: ["Agent Memory"],
		summary: "List memory files for an agent instance",
	})
	.input(listFilesInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const { files, total } = await listMemoryFiles({
			agentInstanceId: input.agentInstanceId,
			userId: context.user.id,
			organizationId,
			path: input.path,
			fileType: input.fileType as AgentMemoryFileType | undefined,
			limit: input.limit,
			offset: input.offset,
		});

		return {
			files,
			total,
			hasMore: input.offset + files.length < total,
		};
	});
