import { deleteAgentTemplate, getAgentTemplate } from "@repo/database";
import { z } from "zod";
import {
	adminProcedure,
	Permissions,
	requirePermission,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../../organizations/lib/membership";

const deleteInputSchema = z.object({
	id: z.string(),
});

export const deleteTemplateProcedure = adminProcedure
	.use(requirePermission(Permissions.AGENT_TEMPLATE_MANAGE))
	.input(deleteInputSchema)
	.handler(async ({ input, context }) => {
		// Verify ownership
		const existing = await getAgentTemplate(input.id);
		if (!existing) {
			throw new Error("Template not found");
		}

		// System templates are admin-managed and may be deleted here.
		if (existing.scope === "SYSTEM") {
			await deleteAgentTemplate(input.id);
			return { success: true };
		}

		// Check permissions based on scope
		if (existing.scope === "USER") {
			// User templates can only be deleted by the owner
			if (existing.userId !== context.user.id) {
				throw new Error(
					"You don't have permission to delete this template",
				);
			}
		} else if (existing.scope === "ORGANIZATION") {
			// Organization templates require org admin/owner membership
			if (!existing.organizationId) {
				throw new Error(
					"Organization template is missing organizationId",
				);
			}
			const membership = await requireOrgMembership(
				context.user.id,
				existing.organizationId,
				["owner", "admin"],
			);
			if (!membership) {
				throw new Error(
					"You must be an organization owner or admin to delete organization templates",
				);
			}
		}

		await deleteAgentTemplate(input.id);

		return { success: true };
	});
