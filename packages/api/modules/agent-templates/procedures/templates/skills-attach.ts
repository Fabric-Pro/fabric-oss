import { attachSkillToTemplate, getSkillById } from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../../organizations/lib/membership";

const attachSkillInputSchema = z.object({
	templateId: z.string().min(1),
	skillId: z.string().min(1),
	sortOrder: z.number().min(0).default(0),
	isRequired: z.boolean().default(true),
});

export const attachTemplateSkillProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_TEMPLATE_MANAGE))
	.input(attachSkillInputSchema)
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

		// Verify skill exists within tenant context
		const skill = await getSkillById(input.skillId, {
			userId: context.user.id,
			organizationId: template.organizationId ?? undefined,
		});
		if (!skill) {
			throw new Error("Skill not found");
		}

		// Enforce same-tenant context: skill must belong to the same tenant as the template
		// SYSTEM skills can be attached to any template
		if (skill.scope !== "SYSTEM") {
			if (
				template.scope === "ORGANIZATION" &&
				skill.scope === "ORGANIZATION"
			) {
				// Both org-scoped: must be the same org
				if (skill.organizationId !== template.organizationId) {
					throw new Error("Skill not found");
				}
			} else if (template.scope === "USER" && skill.scope === "USER") {
				// Both user-scoped: must be the same user
				if (skill.userId !== context.user.id) {
					throw new Error("Skill not found");
				}
			} else {
				// Mismatched scopes (e.g. ORG skill on USER template) — block
				throw new Error("Skill not found");
			}
		}

		const templateSkill = await attachSkillToTemplate({
			templateId: input.templateId,
			skillId: input.skillId,
			sortOrder: input.sortOrder,
			isRequired: input.isRequired,
		});

		return { templateSkill };
	});
