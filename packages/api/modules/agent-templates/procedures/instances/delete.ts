import { ORPCError } from "@orpc/server";
import {
	deleteAgentTemplateInstance,
	getAgentTemplateInstance,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { resolvedOrganizationId } from "../../../agents/procedures/conversations/resolved-organization";

const deleteInputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const deleteInstanceProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.AGENT_TEMPLATE_MANAGE, {
			requireOrganization: true,
		}),
	)
	.input(deleteInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolvedOrganizationId(input, context.session);
		const existing = await getAgentTemplateInstance(input.id);
		if (!existing || existing.organizationId !== organizationId) {
			throw new ORPCError("NOT_FOUND", { message: "Instance not found" });
		}

		await deleteAgentTemplateInstance(input.id);

		return { success: true };
	});
