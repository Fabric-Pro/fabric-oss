import { detachSkillFromTemplate } from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../../organizations/lib/membership";

const detachSkillInputSchema = z.object({
	templateId: z.string().min(1),
	skillId: z.string().min(1),
});

export const detachTemplateSkillProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_TEMPLATE_MANAGE))
	.input(detachSkillInputSchema)
	.handler(async ({ input, context }) => {
		// Verify template exists
		const template = await db.agentTemplate.findUnique({
			where: { id: input.templateId },
		});

		if (!template) {
			throw new Error("Template not found");
		}

		// SYSTEM templates are immutable
		if (template.scope === "SYSTEM") {
			throw new Error("Cannot modify SYSTEM templates");
		}

		// Authorize template modification (matches update/delete pattern)
		if (template.scope === "ORGANIZATION") {
			if (!template.organizationId) {
				throw new Error(
					"Organization template is missing organizationId",
				);
			}
			const membership = await requireOrgMembership(
				context.user.id,
				template.organizationId,
				["owner", "admin"],
			);
			if (!membership) {
				throw new Error(
					"You must be an organization owner or admin to modify organization templates",
				);
			}
		} else if (template.scope === "USER") {
			if (template.userId !== context.user.id) {
				throw new Error("You can only modify your own templates");
			}
		}

		await detachSkillFromTemplate(input.templateId, input.skillId);

		return { success: true };
	});
