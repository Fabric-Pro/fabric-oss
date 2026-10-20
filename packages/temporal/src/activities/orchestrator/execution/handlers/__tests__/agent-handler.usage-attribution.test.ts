import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	delegate: vi.fn(async (_input: unknown) => ({
		status: "completed",
		response: "done",
		artifacts: [],
		durationMs: 1,
	})),
}));
vi.mock("@temporalio/activity", () => ({
	Context: { current: () => ({ heartbeat: vi.fn() }) },
}));
vi.mock("../../../delegation", () => ({
	delegateToAgent: h.delegate,
	resolveAgentEndpoint: vi.fn(async () => ({
		name: "example-agent",
		protocol: "a2a",
	})),
	getAgentCapabilities: vi.fn(),
	buildDelegationMessage: () => "message",
}));
vi.mock("../../../utils/partykit-publisher", () => ({
	publishStepProgress: vi.fn(async () => undefined),
}));
vi.mock("../../../../../activities/weave/enrich-delegation", () => ({
	isWeaveAgent: () => false,
	enrichWeaveDelegationMessage: vi.fn(),
}));

import type { ExecuteStepInput } from "../../../types";
import { AgentHandler } from "../agent-handler";

it.each(["conversation-example", undefined])(
	"uses only the step's conversation for delegated usage (%s)",
	async (conversationId) => {
		h.delegate.mockClear();
		const input = {
			step: {
				id: "step-example",
				capability: "agent",
				executor: "example-agent",
				description: "task",
				inputs: {},
			},
			userId: "user-example",
			conversationId,
			executionId: "execution-example",
			stepIndex: 0,
			totalSteps: 1,
			variables: {},
		} as ExecuteStepInput;
		const result = await new AgentHandler().execute({
			input,
			variables: {},
			toolCalls: [],
			startTime: 0,
		});
		expect(result.handled).toBe(true);
		expect(h.delegate.mock.calls[0][0]).toMatchObject({
			usageConversationId: conversationId,
		});
	},
);
