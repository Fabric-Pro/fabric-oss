/**
 * Create Weave Plan Procedure
 *
 * Creates a weave plan by calling the Pattern planner service directly.
 * Pattern researches the codebase/docs and generates structured checkboxes.
 * The plan is saved in PENDING_APPROVAL status for user review.
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
import { runInBackground } from "../lib/run-in-background";
import { runPatternGeneration } from "../lib/run-pattern-generation";
import { assertWeaveServiceHealthy } from "../lib/weave-preflight";

const CreatePlanInputSchema = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
	userStoryId: z.string().optional(),
	storyTaskId: z.string().optional(),
	name: z.string(),
	description: z.string().optional(),
	message: z.string(),
	techStack: z.string().optional(),
});

const CreatePlanOutputSchema = z.object({
	success: z.boolean(),
	planId: z.string(),
	status: z.string(),
});

export const createPlanProcedure = protectedProcedure
	.use(requirePermission(Permissions.AGENT_CREATE))
	.route({
		method: "POST",
		path: "/weave/plans/create",
		tags: ["Weave"],
		summary: "Create a weave plan",
		description:
			"Calls the Pattern planner to generate a structured execution plan with checkboxes",
	})
	.input(CreatePlanInputSchema)
	.output(CreatePlanOutputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify project access
		const hasAccess = await hasProjectAccess(
			input.projectId,
			userId,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Preflight the planner service before creating any plan row. An
		// unconfigured or unreachable planner throws here, so no row exists
		// and the UI never shows a "Generating plan…" state that cannot
		// complete.
		const patternUrl = await assertWeaveServiceHealthy({
			envVarName: "WEAVE_PLANNERS_URL",
			localFallback: "http://localhost:8142",
			serviceDescription: "The Weave planning service",
		});

		// Get project details for Pattern context
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { name: true, description: true, techStack: true },
		});

		// Create plan record in DRAFT status
		const plan = await db.weavePlan.create({
			data: {
				projectId: input.projectId,
				userStoryId: input.userStoryId,
				storyTaskId: input.storyTaskId,
				name: input.name,
				description: input.description,
				status: "DRAFT",
				checkboxes: [],
				userId,
				organizationId: organizationId ?? null,
			},
		});

		// Run Pattern as a background continuation that outlives the
		// response: the API returns immediately with the planId while the
		// continuation persists the outcome (PENDING_APPROVAL or FAILED) on
		// the plan row. The UI polls for status.
		runInBackground(
			runPatternGeneration({
				planId: plan.id,
				patternUrl,
				message: input.message,
				userId,
				organizationId: organizationId ?? null,
				projectContext: {
					projectId: input.projectId,
					projectName: project?.name || input.name,
					description:
						input.description || project?.description || undefined,
					techStack:
						input.techStack ||
						project?.techStack?.join(", ") ||
						undefined,
				},
				isRevision: false,
				priorDescription: plan.description,
			}),
		);

		return {
			success: true,
			planId: plan.id,
			status: "DRAFT",
		};
	});
