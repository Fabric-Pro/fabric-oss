/**
 * Convert Weave Plan to Orchestrator Task Plan
 *
 * Maps WeaveCheckbox[] from a weave plan into the orchestrator's TaskStep[]
 * format so Fabric Loom can execute it via wave-based scheduling.
 */

import { db } from "@repo/database";
import type { TaskPlan, TaskStep } from "../../workflows/orchestrator/types";

/**
 * WeaveCheckbox type — mirrors the type from @repo/weave-core.
 * Defined inline to avoid build dependency on the weave-core dist output.
 */
interface WeaveCheckbox {
	id: string;
	text: string;
	agent: "thread" | "spindle" | "weft" | "warp" | "shuttle";
	category?: string;
	status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
	requiresReview?: boolean;
	reviewType?: "weft" | "warp" | "both";
	artifacts?: string[];
}

/**
 * Agent ID mapping — maps weave agent names to registered agent IDs.
 */
const WEAVE_AGENT_MAP: Record<string, string> = {
	thread: "weave_thread",
	spindle: "weave_spindle",
	weft: "weave_weft",
	warp: "weave_warp",
	shuttle: "weave_shuttle",
};

/**
 * Converts a weave plan's checkboxes into an orchestrator TaskPlan.
 *
 * Each checkbox becomes a TaskStep with:
 * - capability: "agent" (routed to the appropriate weave agent)
 * - app: the registered agent ID (e.g., "weave_shuttle")
 * - requiresApproval: true if the checkbox has requiresReview
 * - parallelGroup: based on checkbox category for wave parallelization
 */
export async function convertWeavePlanToOrchestratorSteps(input: {
	planId: string;
	userId: string;
	organizationId?: string | null;
}): Promise<TaskPlan> {
	// XOR tenant isolation: validate caller owns this plan
	const plan = await db.weavePlan.findFirstOrThrow({
		where: {
			id: input.planId,
			userId: input.userId,
			...(input.organizationId
				? { organizationId: input.organizationId }
				: { organizationId: null }),
		},
		select: {
			id: true,
			name: true,
			projectId: true,
			userStoryId: true,
			storyTaskId: true,
			checkboxes: true,
		},
	});

	// Load project weave config for auto-review and category routing settings
	const weaveConfig = await db.projectWeaveConfig.findUnique({
		where: { projectId: plan.projectId },
	});

	// Parse category routing: { "frontend": { "model": "gpt-4o" }, "backend": { "model": "claude-sonnet-4-5" } }
	const categoryRouting = (weaveConfig?.categoryRouting ?? {}) as Record<
		string,
		{ model?: string }
	>;

	const checkboxes = plan.checkboxes as unknown as WeaveCheckbox[];

	const steps: TaskStep[] = checkboxes.map(
		(checkbox, index): TaskStep => ({
			id: checkbox.id,
			description: checkbox.text,
			type: "agent",
			status: "pending",
			order: index,
			executor: WEAVE_AGENT_MAP[checkbox.agent] ?? checkbox.agent,
			capability: "agent",
			app: WEAVE_AGENT_MAP[checkbox.agent] ?? checkbox.agent,
			riskLevel: checkbox.agent === "shuttle" ? "medium" : "low",
			requiresApproval: checkbox.requiresReview ?? false,
			// Group independent checkboxes by category for wave parallelization
			parallelGroup: checkbox.category ?? undefined,
			// Shuttle steps depend on any preceding thread/spindle research
			dependsOn: getDependencies(checkbox, checkboxes, index),
			inputs: {
				checkboxId: checkbox.id,
				agent: checkbox.agent,
				category: checkbox.category,
				projectId: plan.projectId,
				weavePlanId: plan.id,
				storyId: plan.userStoryId,
				storyTaskId: plan.storyTaskId,
				// Category-based model override (Shuttle respects this)
				...(checkbox.category &&
				categoryRouting[checkbox.category]?.model
					? {
							modelOverride:
								categoryRouting[checkbox.category].model,
						}
					: {}),
			},
		}),
	);

	// Auto-review: Append Weft/Warp review steps if configured
	const shuttleStepIds = steps
		.filter((s) => s.app === "weave_shuttle")
		.map((s) => s.id);

	if (shuttleStepIds.length > 0) {
		const requireReview = weaveConfig?.requireReview ?? true;
		const requireSecurityReview =
			weaveConfig?.requireSecurityReview ?? true;

		if (requireReview) {
			steps.push({
				id: `auto-review-weft-${plan.id}`,
				description:
					"Quality review: Verify implementation matches requirements",
				type: "verify",
				status: "pending",
				order: steps.length,
				executor: "weave_weft",
				capability: "agent",
				app: "weave_weft",
				riskLevel: "low",
				requiresApproval: true,
				dependsOn: shuttleStepIds,
				inputs: {
					reviewType: "work",
					projectId: plan.projectId,
					weavePlanId: plan.id,
					storyId: plan.userStoryId,
					storyTaskId: plan.storyTaskId,
				},
			});
		}

		if (requireSecurityReview) {
			steps.push({
				id: `auto-review-warp-${plan.id}`,
				description:
					"Security review: Audit for vulnerabilities and spec compliance",
				type: "verify",
				status: "pending",
				order: steps.length,
				executor: "weave_warp",
				capability: "agent",
				app: "weave_warp",
				riskLevel: "low",
				requiresApproval: true,
				dependsOn: shuttleStepIds,
				inputs: {
					reviewType: "security",
					projectId: plan.projectId,
					weavePlanId: plan.id,
					storyId: plan.userStoryId,
					storyTaskId: plan.storyTaskId,
				},
			});
		}
	}

	return {
		id: `weave-plan-${plan.id}`,
		description: plan.name,
		steps,
		riskLevel: steps.some((s) => s.riskLevel === "medium")
			? "medium"
			: "low",
		strategy: "agent",
		createdAt: new Date().toISOString(),
		metadata: {
			isReadOnly: steps.every((s) => s.app !== "weave_shuttle"),
		},
	};
}

/**
 * Infer step dependencies based on agent roles:
 * - Shuttle (write) steps depend on prior Thread/Spindle (research) steps
 * - Weft/Warp (review) steps depend on all prior Shuttle steps
 * - Thread/Spindle are independent of each other
 */
function getDependencies(
	checkbox: WeaveCheckbox,
	allCheckboxes: WeaveCheckbox[],
	currentIndex: number,
): string[] | undefined {
	const prior = allCheckboxes.slice(0, currentIndex);

	if (checkbox.agent === "shuttle") {
		// Shuttle depends on preceding research (thread/spindle) steps
		const researchDeps = prior
			.filter((c) => c.agent === "thread" || c.agent === "spindle")
			.map((c) => c.id);
		return researchDeps.length > 0 ? researchDeps : undefined;
	}

	if (checkbox.agent === "weft" || checkbox.agent === "warp") {
		// Review depends on all preceding shuttle (implementation) steps
		const implDeps = prior
			.filter((c) => c.agent === "shuttle")
			.map((c) => c.id);
		return implDeps.length > 0 ? implDeps : undefined;
	}

	return undefined;
}
