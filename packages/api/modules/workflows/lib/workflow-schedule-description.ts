/**
 * A workflow's schedule in words. Light on purpose (the preset's reader and a
 * pure cron description), so the read tools can show it without loading the
 * commands that write.
 */

import {
	readGraphFacts,
	type WorkflowDraft,
} from "@repo/temporal/agentic-workflow-preset";
import { describeCronSchedule } from "./cron-description";

/**
 * A workflow's schedule in words, read off its graph the way the schedule sync
 * reads it, or null when it has none.
 */
export function describeWorkflowSchedule(
	nodes: unknown,
): WorkflowDraft["schedule"] {
	const { schedule } = readGraphFacts(nodes);
	return schedule
		? {
				...schedule,
				description: describeCronSchedule(
					schedule.cron,
					schedule.timezone,
				),
			}
		: null;
}
