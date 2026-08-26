import { ORPCError } from "@orpc/server";
import { listReportTemplateSkills } from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../../organizations/lib/membership";

const listTemplateSkillsInputSchema = z.object({
	templateId: z.string().min(1),
	organizationId: z.string().nullable().optional(),
});

export const listReportTemplateSkillsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_READ))
	.input(listTemplateSkillsInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify template exists within the caller's tenant context
		const template = await db.reportTemplate.findFirst({
			where: {
				id: input.templateId,
				OR: organizationId
					? [
							{ scope: "ORGANIZATION", organizationId },
							{ scope: "SYSTEM" },
						]
					: [
							{ scope: "USER", userId: context.user.id },
							{ scope: "SYSTEM" },
						],
			},
		});

		if (!template) {
			throw new ORPCError("NOT_FOUND", {
				message: "Template not found",
			});
		}

		// Authorize template access with active tenant context check
		if (template.scope === "ORGANIZATION") {
			if (!template.organizationId) {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: "Organization template is missing organizationId",
				});
			}
			// Ensure caller is in the same org context as the template
			if (template.organizationId !== organizationId) {
				throw new ORPCError("NOT_FOUND", {
					message: "Template not found",
				});
			}
			const membership = await requireOrgMembership(
				context.user.id,
				template.organizationId,
			);
			if (!membership) {
				throw new ORPCError("NOT_FOUND", {
					message: "Template not found",
				});
			}
		} else if (template.scope === "USER") {
			// Personal templates only accessible from personal context by the owner
			if (organizationId || template.userId !== context.user.id) {
				throw new ORPCError("NOT_FOUND", {
					message: "Template not found",
				});
			}
		}
		// SYSTEM templates are readable from any context

		const templateSkills = await listReportTemplateSkills(input.templateId);

		// Filter attached skills by tenant visibility to prevent cross-tenant leaks
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
