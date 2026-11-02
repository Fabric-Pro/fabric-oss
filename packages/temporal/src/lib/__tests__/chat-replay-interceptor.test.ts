import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	current: vi.fn(),
	setHandler: vi.fn(),
	workflowInfo: vi.fn(),
}));
vi.mock("@temporalio/activity", () => ({ Context: { current: h.current } }));
vi.mock("@temporalio/workflow", () => ({
	defineQuery: (name: string) => ({ name }),
	setHandler: h.setHandler,
	workflowInfo: h.workflowInfo,
}));

import { interceptors } from "../../workflows/chat-replay-workflow-interceptor";
import { ChatReplayActivityInboundInterceptor } from "../chat-replay-interceptor";
import {
	markExecutionReplayUnavailable,
	registerExecutionOutputDrain,
} from "../execution-output-drain";

beforeEach(() => {
	vi.resetAllMocks();
	h.current.mockReturnValue({
		info: {
			activityType: "runAgentIteration",
			workflowExecution: { workflowId: "orch-example" },
			attempt: 1,
		},
	});
	h.workflowInfo.mockReturnValue({
		workflowType: "orchestratorExecutionWorkflow",
	});
});
describe("durable replay failure metadata", () => {
	it("records journal failure in an activity result even when no database marker exists", async () => {
		markExecutionReplayUnavailable(h.current());
		const result = await new ChatReplayActivityInboundInterceptor().execute(
			{ args: [], headers: {} },
			vi.fn().mockResolvedValue({ response: "Example" }),
		);
		expect(result).toEqual({
			response: "Example",
			__fabricChatReplayUnavailable: true,
		});
	});
	it("does not disable replay for retries that published nothing", async () => {
		h.current().info.attempt = 2;
		const result = await new ChatReplayActivityInboundInterceptor().execute(
			{ args: [], headers: {} },
			vi.fn().mockResolvedValue({ response: "Example" }),
		);
		expect(result).toEqual({
			response: "Example",
			__fabricChatReplayUnavailable: false,
		});
	});
	it("reconstructs the sticky query flag from history while preserving workflow-visible results and commands", async () => {
		for (let replay = 0; replay < 2; replay++) {
			const stack = interceptors();
			await stack.inbound?.[0].execute?.(
				{ args: [], headers: {} },
				vi.fn(),
			);
			const status = h.setHandler.mock.calls.at(-1)?.[1];
			const input = {
				activityType: "runAgentIteration",
				args: [],
				headers: {},
				options: {},
			};
			const next = vi
				.fn()
				.mockResolvedValueOnce({
					response: "Example",
					__fabricChatReplayUnavailable: true,
				})
				.mockResolvedValueOnce({ response: "Later" });
			expect(
				await stack.outbound?.[0].scheduleActivity?.(
					input as never,
					next,
				),
			).toEqual({ response: "Example" });
			await stack.outbound?.[0].scheduleActivity?.(input as never, next);
			expect(status()).toEqual({ version: 1, unavailable: true });
			expect(next.mock.calls.every(([value]) => value === input)).toBe(
				true,
			);
		}
	});
	it("does not alter legacy activity results", async () => {
		const stack = interceptors();
		const value = { response: "Legacy" };
		expect(
			await stack.outbound?.[0].scheduleActivity?.(
				{} as never,
				vi.fn().mockResolvedValue(value),
			),
		).toBe(value);
	});
});

it.each(["runAgentIteration", "utilityActivity"])(
	"flags only failed producers: %s",
	async (activityType) => {
		const stack = interceptors();
		await stack.inbound?.[0].execute?.({ args: [], headers: {} }, vi.fn());
		const { ActivityFailure, ApplicationFailure, RetryState } =
			await import("@temporalio/common");
		const failure = new ActivityFailure(
			"Activity failed",
			activityType,
			"example-id",
			RetryState.MAXIMUM_ATTEMPTS_REACHED,
			"example-worker",
			ApplicationFailure.create({
				message: "Example",
				type: "ToolError",
			}),
		);
		await expect(
			stack.outbound?.[0].scheduleActivity?.(
				{ activityType } as never,
				vi.fn().mockRejectedValue(failure),
			),
		).rejects.toBe(failure);
		expect(h.setHandler.mock.calls.at(-1)?.[1]()).toEqual({
			version: 1,
			unavailable: activityType === "runAgentIteration",
		});
	},
);
it.each(["cancelled", "application", "usage"])(
	"preserves failure identity when the attempt journal is unavailable: %s",
	async (kind) => {
		const { CancelledFailure, ApplicationFailure } = await import(
			"@temporalio/common"
		);
		class AiUsageLimitExceededError extends Error {
			override name = "AiUsageLimitExceededError";
		}
		const failures = {
			cancelled: new CancelledFailure("Stopped"),
			application: ApplicationFailure.create({
				message: "Example",
				type: "ExampleFailure",
				details: [{ reason: "example" }],
				nonRetryable: true,
			}),
			usage: new AiUsageLimitExceededError("Limit"),
		};
		const failure = failures[kind as keyof typeof failures];
		markExecutionReplayUnavailable(h.current());
		await expect(
			new ChatReplayActivityInboundInterceptor().execute(
				{ args: [], headers: {} },
				vi.fn().mockRejectedValue(failure),
			),
		).rejects.toBe(failure);
	},
);

it("identifies missing old-worker metadata but permits void utility activity results", async () => {
	for (const value of [undefined, { response: "Unjournaled prefix" }]) {
		const stack = interceptors();
		await stack.inbound?.[0].execute?.({ args: [], headers: {} }, vi.fn());
		await stack.outbound?.[0].scheduleActivity?.(
			{
				activityType:
					value === undefined
						? "utilityActivity"
						: "runAgentIteration",
			} as never,
			vi.fn().mockResolvedValue(value),
		);
		expect(h.setHandler.mock.calls.at(-1)?.[1]()).toEqual({
			version: 1,
			unavailable: value !== undefined,
		});
	}
});

it("keeps utility results unchanged for old workflow code that serializes tool data", async () => {
	h.current().info.activityType = "searchProjectSlackMessages";
	const value = { messages: [], totalCount: 0 };
	const result = await new ChatReplayActivityInboundInterceptor().execute(
		{ args: [], headers: {} },
		vi.fn().mockResolvedValue(value),
	);
	expect(result).toBe(value);
});

it.each([undefined, null, false, 0, ""])(
	"preserves falsy thrown values: %s",
	async (failure) => {
		await expect(
			new ChatReplayActivityInboundInterceptor().execute(
				{ args: [], headers: {} },
				vi.fn().mockRejectedValue(failure),
			),
		).rejects.toBe(failure);
	},
);
it("preserves the activity failure even if its output drain rejects", async () => {
	const failure = new Error("Original");
	registerExecutionOutputDrain(h.current(), async () => {
		throw new Error("Drain failed");
	});
	await expect(
		new ChatReplayActivityInboundInterceptor().execute(
			{ args: [], headers: {} },
			vi.fn().mockRejectedValue(failure),
		),
	).rejects.toBe(failure);
});
it.each([
	"runAgentIteration",
	"compactConversationHistoryActivity",
	"executeStep",
	"delegateToAgent",
	"executeAgentAsTool",
	"executeAgentTurn",
])("round trips successful producer metadata: %s", async (activityType) => {
	h.current().info.activityType = activityType;
	const recorded = await new ChatReplayActivityInboundInterceptor().execute(
		{ args: [], headers: {} },
		vi.fn().mockResolvedValue({ response: "Example" }),
	);
	expect(recorded).toEqual({
		response: "Example",
		__fabricChatReplayUnavailable: false,
	});
	const stack = interceptors();
	await stack.inbound?.[0].execute?.({ args: [], headers: {} }, vi.fn());
	expect(
		await stack.outbound?.[0].scheduleActivity?.(
			{ activityType } as never,
			vi.fn().mockResolvedValue(recorded),
		),
	).toEqual({ response: "Example" });
	expect(h.setHandler.mock.calls.at(-1)?.[1]()).toEqual({
		version: 1,
		unavailable: false,
	});
});

it("returns a successful activity result marked unavailable when its drain fails", async () => {
	const failure = new Error("Drain failed");
	registerExecutionOutputDrain(h.current(), async () => {
		throw failure;
	});
	await expect(
		new ChatReplayActivityInboundInterceptor().execute(
			{ args: [], headers: {} },
			vi.fn().mockResolvedValue({}),
		),
	).resolves.toEqual({ __fabricChatReplayUnavailable: true });
});
