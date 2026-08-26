import { ORPCError } from "@orpc/server";
import { detachSkillFromReportTemplate } from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../../organizations/lib/membership";

const detachSkillInputSchema = z.object({
	templateId: z.string().min(1),
	organizationId: z.string().nullable().optional(),
	skillId: z.string().min(1),
});

export const detachReportTemplateSkillProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_UPDATE))
	.input(detachSkillInputSchema)
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

		// SYSTEM templates are immutable
		if (template.scope === "SYSTEM") {
			throw new ORPCError("FORBIDDEN", {
				message: "Cannot modify SYSTEM templates",
			});
		}

		// Authorize template modification with active tenant context check
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
				["owner", "admin"],
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"You must be an organization owner or admin to modify organization templates",
				});
			}
		} else if (template.scope === "USER") {
			// Personal templates only accessible from personal context
			if (organizationId || template.userId !== context.user.id) {
				throw new ORPCError("FORBIDDEN", {
					message: "You can only modify your own templates",
				});
			}
		}

		await detachSkillFromReportTemplate(input.templateId, input.skillId);

		return { success: true };
	});
