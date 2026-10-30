/**
 * `agUiAgentRunWorkflow` owns one durable AG-UI run's lifetime and nothing
 * else. Its activity options are the contract that matters:
 *
 *   - on its own `agui-runs` queue, never document generation's;
 *   - never retried, because an agent run writes through its tools and a
 *     second attempt would run the agent twice;
 *   - heartbeat-bounded, so a lost worker ends the run within 30 s;
 *   - a cancellation waits for the activity, which closes the run's stream
 *     with its cancelled terminal event.
 *
 * Repo convention: mock the activity surface and drive the workflow body.
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	options: [] as Array<Record<string, unknown>>,
	runAgUiAgentActivity: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	ActivityCancellationType: {
		TRY_CANCEL: 0,
		WAIT_CANCELLATION_COMPLETED: 1,
		ABANDON: 2,
	},
	proxyActivities: (options: Record<string, unknown>) => {
		h.options.push(options);
		return { runAgUiAgentActivity: h.runAgUiAgentActivity };
	},
}));

const { agUiAgentRunWorkflow } = await import("../ag-ui-agent-run");

describe("agUiAgentRunWorkflow", () => {
	it("runs its one activity once, on its own queue, waiting out a cancellation", () => {
		expect(h.options).toEqual([
			{
				taskQueue: "agui-runs",
				// The route's 900 s token less 60 s of pickup slack.
				startToCloseTimeout: "840s",
				heartbeatTimeout: "30s",
				cancellationType: 1,
				retry: { maximumAttempts: 1 },
			},
		]);
	});

	it("hands its input to the activity and returns the activity's result", async () => {
		const input = {
			runId: "run-example-0001",
			threadId: "thread-example-0001",
			agentName: "project_document_generator",
			userId: "user-example-1",
			organizationId: "org-example-1",
			inputRef: "agui:run:run-example-0001:input",
			modelHints: {},
		};
		h.runAgUiAgentActivity.mockResolvedValue({
			outcome: "finished",
			events: 12,
		});

		await expect(agUiAgentRunWorkflow(input)).resolves.toEqual({
			outcome: "finished",
			events: 12,
		});
		expect(h.runAgUiAgentActivity).toHaveBeenCalledWith(input);
	});
});
