import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	generateText: vi.fn(async (_request: { maxOutputTokens?: number }) => ({
		text: "Summary",
		usage: { inputTokens: 10, outputTokens: 5 },
	})),
	cap: undefined as number | undefined,
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: vi.fn(async () => ({
		model: {},
		metadata: { maxOutputTokens: mocks.cap },
	})),
}));
vi.mock("ai", () => ({ generateText: mocks.generateText }));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../../../../lib/redis-publisher", () => ({
	publishExecutionEvent: vi.fn(),
}));
vi.mock("../../turn-dispatch", () => ({
	guardTurnModel: (model: unknown) => ({ model }),
	activityAbortSignal: () => undefined,
	rethrowIfTurnStopped: () => undefined,
	startHeartbeatTicker: () => () => undefined,
}));

import { compactConversationHistoryActivity } from "../compact-conversation";

beforeEach(() => {
	mocks.generateText.mockClear();
});
describe("compaction output cap", () => {
	it.each([8192, 32768, undefined])(
		"caps a requested summary at model limit %s",
		async (cap) => {
			mocks.cap = cap;
			await compactConversationHistoryActivity({
				oldTurns: [
					{
						role: "user",
						content: "Example",
						timestamp: "2026-01-01",
					},
				],
				currentTask: "Summarize",
				userId: "example-user",
				organizationId: "example-org",
				maxSummaryTokens: 16384,
			});
			expect(mocks.generateText.mock.calls[0]?.[0].maxOutputTokens).toBe(
				cap === 8192 ? 8192 : 16384,
			);
		},
	);
});

it("renders response notes and calls in order and attributes results to their response", async () => {
	const timestamp = "2026-01-01";
	await compactConversationHistoryActivity({
		oldTurns: [
			{
				role: "assistant",
				content: "First note.Second note.",
				assistantParts: [
					{ type: "text", text: "First note." },
					{ type: "tool-call", toolCallId: "example-call" },
					{ type: "text", text: "Second note." },
				],
				toolCalls: [
					{ id: "example-call", name: "first_tool", args: {} },
				],
				timestamp,
			},
			{
				role: "tool",
				content: "first evidence",
				toolCallId: "example-call",
				timestamp,
			},
			{
				role: "assistant",
				content: "Later note.",
				toolCalls: [
					{ id: "example-call", name: "second_tool", args: {} },
				],
				timestamp,
			},
			{
				role: "tool",
				content: "second evidence",
				toolCallId: "example-call",
				timestamp,
			},
		],
		currentTask: "Compare",
		userId: "example-user",
		maxSummaryTokens: 4000,
	});
	const prompt =
		(mocks.generateText.mock.calls[0][0] as { prompt?: string }).prompt ??
		"";
	expect(prompt).toContain("TOOL_RESULT[first_tool]: first evidence");
	expect(prompt.indexOf("First note.")).toBeLessThan(
		prompt.indexOf("ASSISTANT_TOOL_CALL: first_tool"),
	);
	expect(prompt.indexOf("ASSISTANT_TOOL_CALL: first_tool")).toBeLessThan(
		prompt.indexOf("Second note."),
	);
	expect(prompt).toContain("TOOL_RESULT[second_tool]: second evidence");
});
