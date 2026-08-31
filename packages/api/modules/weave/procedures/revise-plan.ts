/**
 * Revise Weave Plan Procedure
 *
 * Instead of rejecting a plan (which cancels it), users can request revision.
 * This sets the plan to NEEDS_REVISION, then re-triggers Pattern with the
 * original plan context + user feedback so Pattern can generate an improved plan.
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
import { runInBackground } from "../lib/run-in-background";
import { runPatternGeneration } from "../lib/run-pattern-generation";
import { assertWeaveServiceHealthy } from "../lib/weave-preflight";

const RevisePlanInputSchema = z.object({
	planId: z.string(),
	organizationId: z.string().nullable().optional(),
	feedback: z.string().min(1, "Revision feedback is required"),
});

export const revisePlanProcedure = protectedProcedure
	.route({
		method: "POST",
		path: "/weave/plans/:planId/revise",
		tags: ["Weave"],
		summary: "Request revision of a weave plan",
		description:
			"Sets the plan to NEEDS_REVISION and re-triggers Pattern with the prior plan + feedback",
	})
	.input(RevisePlanInputSchema)
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
			include: {
				project: {
					select: { name: true, description: true, techStack: true },
				},
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

		if (
			plan.status !== "PENDING_APPROVAL" &&
			plan.status !== "NEEDS_REVISION"
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Plan cannot be revised in status: ${plan.status}`,
			});
		}

		// Preflight the planner service before touching the plan. An
		// unreachable planner throws here and the plan stays reviewable in
		// its current status.
		const patternUrl = await assertWeaveServiceHealthy({
			envVarName: "WEAVE_PLANNERS_URL",
			localFallback: "http://localhost:8142",
			serviceDescription: "The Weave planning service",
		});

		// Set status to NEEDS_REVISION and clear old description (will be replaced by progress)
		await db.weavePlan.update({
			where: { id: input.planId },
			data: {
				status: "NEEDS_REVISION",
				description: "Revising plan based on feedback...",
			},
		});

		// Build context message that includes the prior plan + feedback
		const priorCheckboxes = plan.checkboxes as Array<{
			id: string;
			text: string;
			agent: string;
		}>;
		const priorPlanText = priorCheckboxes
			.map((cb, i) => `${i + 1}. [${cb.agent}] ${cb.text}`)
			.join("\n");

		const revisionMessage = [
			"## Revision request",
			"",
			"A previous plan was created but needs changes based on user feedback.",
			"",
			"### Previous plan",
			priorPlanText,
			"",
			"### User feedback",
			input.feedback,
			"",
			"Please generate an improved plan that addresses the feedback. Keep steps that were fine, modify or remove steps the user flagged, and add new steps if needed.",
		].join("\n");

		// Re-run Pattern as a background continuation that outlives the
		// response. A failed revision restores PENDING_APPROVAL so the prior
		// checkboxes stay reviewable.
		runInBackground(
			runPatternGeneration({
				planId: plan.id,
				patternUrl,
				message: revisionMessage,
				userId,
				organizationId: organizationId ?? null,
				projectContext: {
					projectId: plan.projectId,
					projectName: plan.project.name || plan.name,
					description: plan.project.description || undefined,
					techStack: plan.project.techStack?.join(", ") || undefined,
				},
				isRevision: true,
				priorDescription: plan.description,
			}),
		);

		return {
			success: true,
			planId: input.planId,
			status: "NEEDS_REVISION",
		};
	});
