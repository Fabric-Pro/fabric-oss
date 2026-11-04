import { z } from "zod";

/** Routing marker only. Every firing must independently verify current ownership and permissions. */
const MANAGED_AGENT_RUN_SCHEDULE_VERSION = 1;
export const managedAgentRunScheduleSchema = z
	.object({
		fabricManagedRunSchedule: z.literal(MANAGED_AGENT_RUN_SCHEDULE_VERSION),
		_pausedByLifecycle: z.literal(true).optional(),
		inputTemplate: z
			.object({ message: z.string().trim().min(1).max(20000) })
			.strict(),
	})
	.strict();
export function isManagedAgentRunSchedule(config: unknown): boolean {
	return (
		config !== null &&
		typeof config === "object" &&
		!Array.isArray(config) &&
		"fabricManagedRunSchedule" in config
	);
}
export function managedAgentRunTriggerId(deploymentId: string) {
	return `fabric-run-schedule-${deploymentId}`;
}
export function managedAgentRunTemporalScheduleId(triggerId: string) {
	return `trigger-schedule-${triggerId}`;
}
