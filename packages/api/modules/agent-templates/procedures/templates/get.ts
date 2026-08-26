import { ORPCError } from "@orpc/server";
import { getAgentTemplate } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const getInputSchema = z.object({
	slugOrId: z.string(),
});

export const getTemplateProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_TEMPLATE_READ))
	.input(getInputSchema)
	.handler(async ({ input }) => {
		const template = await getAgentTemplate(input.slugOrId);

		if (!template) {
			throw new ORPCError("NOT_FOUND", {
				message: "Template not found",
			});
		}

		return { template };
	});
