import { loadAgentMemoryContext } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const loadContextInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	agentInstanceId: z.string(),
});

export const loadContextProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_MEMORY_READ))
	.route({
		method: "GET",
		path: "/agent-memory/context",
		tags: ["Agent Memory"],
		summary: "Load all memory context for agent execution",
	})
	.input(loadContextInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const memoryContext = await loadAgentMemoryContext({
			agentInstanceId: input.agentInstanceId,
			userId: context.user.id,
			organizationId,
		});

		return memoryContext;
	});
