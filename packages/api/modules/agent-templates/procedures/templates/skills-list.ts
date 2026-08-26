import { listTemplateSkills } from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../../organizations/lib/membership";

const listTemplateSkillsInputSchema = z.object({
	templateId: z.string().min(1),
});

export const listTemplateSkillsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_TEMPLATE_READ))
	.input(listTemplateSkillsInputSchema)
	.handler(async ({ input, context }) => {
		// Verify template exists and caller has access
		const template = await db.agentTemplate.findUnique({
			where: { id: input.templateId },
		});

		if (!template) {
			throw new Error("Template not found");
		}

		// Authorize template access (matches update/delete pattern for ORG)
		if (template.scope === "ORGANIZATION") {
			if (!template.organizationId) {
				throw new Error(
					"Organization template is missing organizationId",
				);
			}
			const membership = await requireOrgMembership(
				context.user.id,
				template.organizationId,
			);
			if (!membership) {
				throw new Error("Template not found");
			}
		} else if (template.scope === "USER") {
			if (template.userId !== context.user.id) {
				throw new Error("Template not found");
			}
		}

		const templateSkills = await listTemplateSkills(input.templateId);

		// Filter attached skills by tenant visibility to prevent cross-tenant leaks
		// (e.g. if a cross-tenant association was created before this fix)
		const visibleSkills = templateSkills.filter((ts) => {
			const skill = ts.skill;
			if (skill.scope === "SYSTEM") {
				return true;
			}
			if (skill.scope === "ORGANIZATION") {
				return skill.organizationId === template.organizationId;
			}
			if (skill.scope === "USER") {
				return skill.userId === context.user.id;
			}
			return false;
		});

		return {
			skills: visibleSkills.map((ts) => ({
				id: ts.id,
				skillId: ts.skillId,
				isRequired: ts.isRequired,
				sortOrder: ts.sortOrder,
				createdAt: ts.createdAt,
				skill: ts.skill,
			})),
		};
	});
