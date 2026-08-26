/**
 * Use Weave Plan Template Procedure
 *
 * Increments the useCount of a template when it is applied to create a new plan.
 * Returns the template data for pre-filling the form.
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requirePermission,
	resolveOrganizationId,
} from "../../../orpc/procedures";

const UseTemplateInputSchema = z.object({
	templateId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const useTemplateProcedure = protectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.route({
		method: "POST",
		path: "/weave/templates/:templateId/use",
		tags: ["Weave"],
		summary: "Apply a template (increments usage count and returns data)",
	})
	.input(UseTemplateInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const template = await db.weavePlanTemplate.findFirst({
			where: {
				id: input.templateId,
				userId,
				...(organizationId
					? { organizationId }
					: { organizationId: null }),
			},
		});

		if (!template) {
			throw new ORPCError("NOT_FOUND", {
				message: "Template not found or access denied",
			});
		}

		// Increment use count
		await db.weavePlanTemplate.update({
			where: { id: input.templateId },
			data: { useCount: { increment: 1 } },
		});

		return {
			success: true,
			template: {
				name: template.name,
				description: template.description,
				message: template.message,
				checkboxes: template.checkboxes,
				category: template.category,
			},
		};
	});
