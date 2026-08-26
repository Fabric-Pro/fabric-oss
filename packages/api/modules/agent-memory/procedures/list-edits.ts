import { listPendingEdits } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const listEditsInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	agentInstanceId: z.string(),
});

export const listEditsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_MEMORY_READ))
	.route({
		method: "GET",
		path: "/agent-memory/edits",
		tags: ["Agent Memory"],
		summary: "List pending memory edits for approval",
	})
	.input(listEditsInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const edits = await listPendingEdits({
			agentInstanceId: input.agentInstanceId,
			userId: context.user.id,
			organizationId,
		});

		return { edits };
	});
