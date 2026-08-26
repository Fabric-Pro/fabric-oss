/**
 * Save Weave Plan Template Procedure
 *
 * Saves a plan's checkboxes and message as a reusable template.
 * Can be scoped to a project or made global (projectId = null).
 */

import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requirePermission,
	resolveOrganizationId,
} from "../../../orpc/procedures";

const SaveTemplateInputSchema = z.object({
	planId: z.string(),
	organizationId: z.string().nullable().optional(),
	name: z.string().min(1, "Template name is required"),
	description: z.string().optional(),
	category: z.string().optional(),
	/** If true, saves as a global template (not project-scoped) */
	global: z.boolean().default(false),
});

export const saveTemplateProcedure = protectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.route({
		method: "POST",
		path: "/weave/templates",
		tags: ["Weave"],
		summary: "Save a plan as a reusable template",
	})
	.input(SaveTemplateInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Fetch the source plan
		const plan = await db.weavePlan.findFirst({
			where: {
				id: input.planId,
				userId,
				...(organizationId
					? { organizationId }
					: { organizationId: null }),
			},
		});

		if (!plan) {
			throw new ORPCError("NOT_FOUND", {
				message: "Plan not found or access denied",
			});
		}

		const hasAccess = await hasProjectAccess(
			plan.projectId,
			userId,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const template = await db.weavePlanTemplate.create({
			data: {
				userId,
				organizationId: organizationId ?? null,
				projectId: input.global ? null : plan.projectId,
				name: input.name,
				description: input.description ?? plan.description,
				category: input.category,
				checkboxes: plan.checkboxes ?? [],
				message: plan.name,
			},
		});

		return {
			success: true,
			templateId: template.id,
			message: "Template saved",
		};
	});
