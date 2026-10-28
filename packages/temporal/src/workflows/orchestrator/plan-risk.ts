import type { TaskPlan } from "./types/task.types";

/** Resolve the display risk while retaining elevated step warnings. */
export function resolvePlanRisk(
	plan: Pick<TaskPlan, "steps"> & Partial<Pick<TaskPlan, "riskLevel">>,
): TaskPlan["riskLevel"] {
	if (plan.steps.some((step) => step.riskLevel === "critical")) {
		return "critical";
	}
	if (plan.steps.some((step) => step.riskLevel === "high")) {
		return "high";
	}
	return plan.riskLevel || "low";
}
