import {
	deleteAgentTemplateInstance,
	getAgentTemplateInstance,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

const deleteInputSchema = z.object({
	id: z.string(),
});

export const deleteInstanceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_TEMPLATE_MANAGE))
	.input(deleteInputSchema)
	.handler(async ({ input, context }) => {
		// Verify ownership or org membership
		const existing = await getAgentTemplateInstance(input.id);
		if (!existing) {
			throw new Error("Instance not found");
		}

		const isOwner = existing.userId === context.user.id;
		let isOrgMember = false;

		if (existing.organizationId) {
			const membership = await verifyOrganizationMembership(
				existing.organizationId,
				context.user.id,
			);
			isOrgMember = !!membership;
		}

		if (!isOwner && !isOrgMember) {
			throw new Error(
				"You don't have permission to delete this instance",
			);
		}

		await deleteAgentTemplateInstance(input.id);

		return { success: true };
	});
