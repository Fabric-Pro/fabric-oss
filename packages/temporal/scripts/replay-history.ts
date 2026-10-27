import type { History } from "@temporalio/common/lib/proto-utils";

/**
 * Coverage requires a started workflow task. In a probe against SDK 1.23
 * (2026-10-27), a history ending at TaskScheduled replayed, but a delayed start
 * with no task stalled replay until the test timed out (Fizzy #3382).
 * Both callers use SDK-decoded histories, whose started events carry this field.
 */
export function hasWorkflowTaskToReplay(history: History): boolean {
	return (
		history.events?.some(
			(event) => event.workflowTaskStartedEventAttributes != null,
		) ?? false
	);
}
