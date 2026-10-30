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
import { markExecutionReplayUnavailable } from "../execution-output-drain";

beforeEach(() => {
	vi.resetAllMocks();
	h.current.mockReturnValue({
		info: { workflowExecution: { workflowId: "orch-example" }, attempt: 1 },
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
	it("fails closed when an activity retried on a different worker", async () => {
		h.current().info.attempt = 2;
		const result = await new ChatReplayActivityInboundInterceptor().execute(
			{ args: [], headers: {} },
			vi.fn().mockResolvedValue({ response: "Example" }),
		);
		expect(result).toMatchObject({ __fabricChatReplayUnavailable: true });
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
				activityType: "exampleActivity",
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
