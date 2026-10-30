/**
 * agUiAgentRunWorkflow — one durable AG-UI agent run (a CopilotKit assistant
 * turn), started by the web runtime under the id `agui-run-<runId>`.
 *
 * The workflow only owns the run's lifetime; its single activity runs the
 * agent and streams the events to Redis (`activities/ag-ui-agent-run.ts`,
 * contract in `lib/agui-run-contract.ts` and `lib/agui-run-stream.ts`). A closed browser tab never touches
 * it; only a stop (workflow cancellation) does, and the activity is waited
 * for so it can close the run's stream with its cancelled terminal event.
 *
 * Neither the workflow nor the activity retries: an agent run is not
 * idempotent (it writes documents through its tools), so a failure ends the
 * run with an error event rather than running the agent a second time.
 */

import {
	ActivityCancellationType,
	proxyActivities,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import {
	AGUI_RUN_MAX_DURATION_SECONDS,
	AGUI_RUN_TASK_QUEUE,
	type AgUiAgentRunResult,
	type AgUiAgentRunWorkflowInput,
} from "../lib/agui-run-contract";

const { runAgUiAgentActivity } = proxyActivities<typeof activities>({
	taskQueue: AGUI_RUN_TASK_QUEUE,
	startToCloseTimeout: `${AGUI_RUN_MAX_DURATION_SECONDS}s`,
	// The activity heartbeats on every event and at least every 10 s while
	// the agent is quiet; a dead worker is noticed within this.
	heartbeatTimeout: "30s",
	cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
	retry: { maximumAttempts: 1 },
});

export async function agUiAgentRunWorkflow(
	input: AgUiAgentRunWorkflowInput,
): Promise<AgUiAgentRunResult> {
	return runAgUiAgentActivity(input);
}
