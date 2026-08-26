import { getFeaturedAgentTemplates } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const featuredInputSchema = z.object({
	limit: z.number().min(1).max(10).default(4),
});

export const getFeaturedProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_TEMPLATE_READ))
	.input(featuredInputSchema)
	.handler(async ({ input }) => {
		const templates = await getFeaturedAgentTemplates(input.limit);

		return { templates };
	});
