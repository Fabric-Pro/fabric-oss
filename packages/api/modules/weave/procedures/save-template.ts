/**
 * Save Weave Plan Template Procedure
 *
 * Saves a plan's checkboxes and message as a reusable template.
 * Can be scoped to a project or made global (projectId = null).
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	assertProjectPermission,
	Permissions,
	protectedProcedure,
	resolveOrganizationIdForCaller,
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
	.route({
		method: "POST",
		path: "/weave/templates",
		tags: ["Weave"],
		summary: "Save a plan as a reusable template",
	})
	.input(SaveTemplateInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			userId,
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

		// Object-level, and the same decision the middleware makes for a
		// procedure whose input names the project. This one names a plan, so
		// the project is only known here.
		await assertProjectPermission(
			plan.projectId,
			userId,
			Permissions.AGENT_UPDATE,
		);

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
