import { exportMemory } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const exportMemoryInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	agentInstanceId: z.string(),
});

export const exportMemoryProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_MEMORY_MANAGE))
	.route({
		method: "GET",
		path: "/agent-memory/export",
		tags: ["Agent Memory"],
		summary: "Export all memory files as a JSON object",
	})
	.input(exportMemoryInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const files = await exportMemory({
			agentInstanceId: input.agentInstanceId,
			userId: context.user.id,
			organizationId,
		});

		return {
			files,
			exportedAt: new Date().toISOString(),
		};
	});
