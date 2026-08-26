/**
 * Retry Weave Plan Generation Procedure
 *
 * Re-runs the Pattern planner for a plan whose generation FAILED. The plan
 * row is reset to DRAFT so the existing UI polling flow resumes, and the
 * shared continuation persists the outcome (PENDING_APPROVAL or FAILED
 * again — a failed retry remains retryable).
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

const RetryGenerationInputSchema = z.object({
	planId: z.string(),
	organizationId: z.string().nullable().optional(),
});

const RetryGenerationOutputSchema = z.object({
	success: z.boolean(),
	planId: z.string(),
	status: z.string(),
});

/**
 * Rebuild the Pattern task statement for a retry.
 *
 * The original request message is not persisted on the plan, so it is
 * reconstructed server-side:
 * - Feature-linked plans rebuild the create-from-feature shape
 *   ("Implement feature: <title>" + description + acceptance criteria,
 *   absent parts omitted) with full fidelity.
 * - Standalone plans fall back to the plan name as the task statement —
 *   the pre-failure description was overwritten by the error text, so the
 *   name is the best remaining seed. Pattern re-researches the codebase
 *   from the task statement either way.
 */
function rebuildRetryMessage(plan: {
	name: string;
	userStory: {
		title: string;
		description: string | null;
		acceptanceCriteria: string | null;
	} | null;
}): string {
	if (plan.userStory) {
		const parts = [
			plan.userStory.description,
			plan.userStory.acceptanceCriteria,
		].filter(Boolean);
		return parts.length > 0
			? `Implement feature: ${plan.userStory.title}\n\n${parts.join("\n\n")}`
			: `Implement feature: ${plan.userStory.title}`;
	}
	return `Implement: ${plan.name}`;
}

export const retryGenerationProcedure = protectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.route({
		method: "POST",
		path: "/weave/plans/:planId/retry-generation",
		tags: ["Weave"],
		summary: "Retry failed plan generation",
		description:
			"Re-runs the Pattern planner for a FAILED plan and resets it to DRAFT so the UI resumes polling",
	})
	.input(RetryGenerationInputSchema)
	.output(RetryGenerationOutputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
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
				userStory: {
					select: {
						title: true,
						description: true,
						acceptanceCriteria: true,
					},
				},
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

		if (plan.status !== "FAILED") {
			throw new ORPCError("BAD_REQUEST", {
				message: `Only failed plans can be retried (current status: ${plan.status}).`,
			});
		}

		// Preflight the planner service before any write. An unreachable
		// planner throws here and the plan stays FAILED (still retryable).
		const patternUrl = await assertWeaveServiceHealthy({
			envVarName: "WEAVE_PLANNERS_URL",
			localFallback: "http://localhost:8142",
			serviceDescription: "The Weave planning service",
		});

		const message = rebuildRetryMessage(plan);

		await db.weavePlan.update({
			where: { id: plan.id },
			data: {
				status: "DRAFT",
				description: "Retrying plan generation...",
			},
		});

		// Re-run Pattern as a background continuation that outlives the
		// response. `isRevision: false` — a failed retry flips the plan back
		// to FAILED and remains retryable.
		runInBackground(
			runPatternGeneration({
				planId: plan.id,
				patternUrl,
				message,
				userId,
				organizationId: organizationId ?? null,
				projectContext: {
					projectId: plan.projectId,
					projectName: plan.project.name || plan.name,
					description: plan.project.description || undefined,
					techStack: plan.project.techStack?.join(", ") || undefined,
				},
				isRevision: false,
			}),
		);

		return {
			success: true,
			planId: plan.id,
			status: "DRAFT",
		};
	});
