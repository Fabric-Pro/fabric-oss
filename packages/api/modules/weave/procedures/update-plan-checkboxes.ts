/**
 * Update Weave Plan Checkboxes Procedure
 *
 * Persists user edits to plan steps (reorder, add, delete, reassign agent).
 * Only allowed on plans in DRAFT or PENDING_APPROVAL status.
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

const WeaveCheckboxSchema = z.object({
	id: z.string(),
	text: z.string().min(1, "Step description is required"),
	agent: z.enum(["thread", "spindle", "shuttle", "weft", "warp"]),
	category: z.string().optional(),
	status: z
		.enum(["pending", "in_progress", "completed", "failed", "skipped"])
		.default("pending"),
	requiresReview: z.boolean().optional(),
	reviewType: z.enum(["weft", "warp", "both"]).optional(),
});

const UpdatePlanCheckboxesInputSchema = z.object({
	planId: z.string(),
	organizationId: z.string().nullable().optional(),
	checkboxes: z
		.array(WeaveCheckboxSchema)
		.min(1, "Plan must have at least one step"),
});

export const updatePlanCheckboxesProcedure = protectedProcedure
	.route({
		method: "POST",
		path: "/weave/plans/:planId/checkboxes",
		tags: ["Weave"],
		summary: "Update plan checkboxes (reorder, add, delete, reassign)",
		description:
			"Persists user edits to plan steps. Only allowed on DRAFT or PENDING_APPROVAL plans.",
	})
	.input(UpdatePlanCheckboxesInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			userId,
		);

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

		if (plan.status !== "DRAFT" && plan.status !== "PENDING_APPROVAL") {
			throw new ORPCError("BAD_REQUEST", {
				message: `Plan steps cannot be edited in status: ${plan.status}`,
			});
		}

		await db.weavePlan.update({
			where: { id: input.planId },
			data: { checkboxes: input.checkboxes },
		});

		return {
			success: true,
			planId: input.planId,
			message: "Plan steps updated",
		};
	});
