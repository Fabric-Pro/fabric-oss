import { ORPCError } from "@orpc/server";
import { initializeMemoryFromTemplate, listMemoryFiles } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const initializeMemoryInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	agentInstanceId: z.string(),
	templateId: z.string(),
	force: z.boolean().default(false), // Force re-initialization even if files exist
});

export const initializeMemoryProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_MEMORY_MANAGE))
	.route({
		method: "POST",
		path: "/agent-memory/initialize",
		tags: ["Agent Memory"],
		summary: "Initialize memory files from a template",
	})
	.input(initializeMemoryInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Check if memory already exists
		const { total: existingFiles } = await listMemoryFiles({
			agentInstanceId: input.agentInstanceId,
			userId: context.user.id,
			organizationId,
			limit: 1,
		});

		if (existingFiles > 0 && !input.force) {
			throw new ORPCError("CONFLICT", {
				message:
					"Memory files already exist. Use force=true to re-initialize.",
			});
		}

		const files = await initializeMemoryFromTemplate({
			agentInstanceId: input.agentInstanceId,
			templateId: input.templateId,
			userId: context.user.id,
			organizationId,
		});

		return {
			files,
			initialized: true,
		};
	});
