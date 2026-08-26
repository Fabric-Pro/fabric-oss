/**
 * Conversation compaction trigger logic
 *
 * Exercises `maybeCompactConversationHistory` and the orphan-trim helpers.
 * These are the load-bearing pieces of the long-conversation summarization
 * feature: getting the gating wrong either thrashes the LLM (compacts every
 * iteration) or never fires (and we hit the hard token cap with poison-text
 * fallback).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const activityStubs = vi.hoisted(() => ({
	compactConversationHistoryActivity: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
	patched: vi.fn(() => true),
	proxyActivities: vi.fn(() => activityStubs),
	workflowInfo: vi.fn(() => ({ unsafe: { isReplaying: false } })),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

import {
	maybeCompactConversationHistory,
	trimLeadingOrphans,
	trimTrailingOrphans,
} from "../src/workflows/orchestrator/phases/iterative-execution";
import type {
	IterativeMessage,
	WorkflowState,
} from "../src/workflows/orchestrator/types";

function msg(
	role: IterativeMessage["role"],
	content: string,
	extras: Partial<IterativeMessage> = {},
): IterativeMessage {
	return {
		role,
		content,
		timestamp: "2026-04-29T16:00:00.000Z",
		...extras,
	};
}

function userMsg(content = "Help me build something") {
	return msg("user", content);
}

function assistantText(content: string) {
	return msg("assistant", content);
}

function assistantToolCall(toolName: string, toolCallId = `tc-${toolName}`) {
	return msg("assistant", "", {
		toolCalls: [{ id: toolCallId, name: toolName, args: { q: "x" } }],
	});
}

function toolResult(toolCallId: string, content = "result") {
	return msg("tool", content, { toolCallId });
}

function buildState(overrides: Partial<WorkflowState> = {}): WorkflowState {
	return {
		executionId: "orch-test",
		lastCompactionIteration: 0,
		iterationCosts: [],
		iterativeConversationHistory: [],
		// All other fields are unread by maybeCompactConversationHistory.
		...overrides,
	} as unknown as WorkflowState;
}

beforeEach(() => {
	vi.clearAllMocks();
	activityStubs.compactConversationHistoryActivity.mockResolvedValue({
		summaryText: "PROGRESS SO FAR — established context.",
		usage: { inputTokens: 1234, outputTokens: 567 },
	});
});

describe("trimLeadingOrphans", () => {
	it("returns slice unchanged when first message is not a tool result", () => {
		const slice = [userMsg(), assistantText("ok")];
		expect(trimLeadingOrphans(slice)).toBe(slice);
	});

	it("drops leading tool messages whose tool_call lives outside the slice", () => {
		const slice = [
			toolResult("tc-1"),
			toolResult("tc-2"),
			userMsg("next turn"),
			assistantText("ok"),
		];
		const result = trimLeadingOrphans(slice);
		expect(result).toHaveLength(2);
		expect(result[0].role).toBe("user");
	});

	it("returns empty array when entire slice is orphan tool results", () => {
		const slice = [toolResult("tc-1"), toolResult("tc-2")];
		expect(trimLeadingOrphans(slice)).toEqual([]);
	});
});

describe("trimTrailingOrphans", () => {
	it("returns slice unchanged when last message has no tool calls", () => {
		const slice = [userMsg(), assistantText("done")];
		expect(trimTrailingOrphans(slice)).toBe(slice);
	});

	it("drops a trailing assistant message whose tool_calls would be orphaned", () => {
		const slice = [userMsg(), assistantToolCall("read_me")];
		const result = trimTrailingOrphans(slice);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("user");
	});

	it("keeps a trailing assistant message that has only text content", () => {
		const slice = [userMsg(), assistantText("here is the answer")];
		expect(trimTrailingOrphans(slice)).toHaveLength(2);
	});

	it("handles empty slice", () => {
		expect(trimTrailingOrphans([])).toEqual([]);
	});
});

describe("maybeCompactConversationHistory — gating", () => {
	it("no-ops when token usage is below the trigger threshold", async () => {
		const state = buildState();
		const history = [
			userMsg(),
			...Array.from({ length: 20 }, () => assistantText("turn")),
		];

		await maybeCompactConversationHistory(
			state,
			history,
			/* iteration */ 5,
			/* cumulativeTokens */ 1_000,
			/* maxTotalTokens */ 100_000, // 1% used, threshold is 70%
			"user-1",
		);

		expect(
			activityStubs.compactConversationHistoryActivity,
		).not.toHaveBeenCalled();
		expect(state.lastCompactionIteration).toBe(0);
	});

	it("no-ops when within cooldown window after a previous compaction", async () => {
		const state = buildState({ lastCompactionIteration: 4 });
		const history = [
			userMsg(),
			...Array.from({ length: 20 }, () => assistantText("turn")),
		];

		// Budget is 90% used (well above 70%) but iteration 5 - 4 = 1 < cooldown=3.
		await maybeCompactConversationHistory(
			state,
			history,
			5,
			90_000,
			100_000,
			"user-1",
		);

		expect(
			activityStubs.compactConversationHistoryActivity,
		).not.toHaveBeenCalled();
	});

	it("no-ops when history is shorter than 1 + minTurnsToCompact + keepRecentTurns", async () => {
		const state = buildState();
		// keepRecentTurns=6, minTurnsToCompact=4 → minimum total = 11.
		const history = Array.from({ length: 8 }, (_, i) =>
			i === 0 ? userMsg() : assistantText(`turn ${i}`),
		);

		await maybeCompactConversationHistory(
			state,
			history,
			10,
			95_000,
			100_000,
			"user-1",
		);

		expect(
			activityStubs.compactConversationHistoryActivity,
		).not.toHaveBeenCalled();
	});

	it("no-ops when middle slice falls below minTurnsToCompact after orphan trimming", async () => {
		const state = buildState();
		// 11 messages — exactly the length-gate floor. Middle = slice(1, -6) =
		// [a, b, c, assistantToolCall]. trimTrailing drops the orphan tool_call,
		// leaving 3 < minTurnsToCompact (4), so compaction must abort.
		const history: IterativeMessage[] = [
			userMsg(),
			assistantText("a"),
			assistantText("b"),
			assistantText("c"),
			assistantToolCall("read_me", "tc-1"), // last middle msg → orphan
			toolResult("tc-1"), // first recent msg
			assistantText("recent-2"),
			assistantText("recent-3"),
			assistantText("recent-4"),
			assistantText("recent-5"),
			assistantText("recent-6"),
		];

		await maybeCompactConversationHistory(
			state,
			history,
			10,
			95_000,
			100_000,
			"user-1",
		);

		expect(
			activityStubs.compactConversationHistoryActivity,
		).not.toHaveBeenCalled();
	});
});

describe("maybeCompactConversationHistory — compaction execution", () => {
	function buildLongHistory(): IterativeMessage[] {
		// 14 messages: original user + 7 compactable middle + 6 recent.
		return [
			userMsg("Original task: build a system"),
			assistantText("middle-1"),
			assistantText("middle-2"),
			assistantText("middle-3"),
			assistantText("middle-4"),
			assistantText("middle-5"),
			assistantText("middle-6"),
			assistantText("middle-7"),
			assistantText("recent-1"),
			assistantText("recent-2"),
			assistantText("recent-3"),
			assistantText("recent-4"),
			assistantText("recent-5"),
			assistantText("recent-6"),
		];
	}

	it("calls compaction activity when threshold + cooldown + length all pass", async () => {
		const state = buildState();
		const history = buildLongHistory();

		await maybeCompactConversationHistory(
			state,
			history,
			10,
			95_000,
			100_000,
			"user-1",
			"org-1",
		);

		expect(
			activityStubs.compactConversationHistoryActivity,
		).toHaveBeenCalledTimes(1);
		const call =
			activityStubs.compactConversationHistoryActivity.mock.calls[0][0];
		expect(call.userId).toBe("user-1");
		expect(call.organizationId).toBe("org-1");
		expect(call.executionId).toBe("orch-test");
		expect(call.iteration).toBe(10);
		expect(call.currentTask).toContain("Original task");
		// 7 middle turns are passed in (after orphan trim there are no orphans)
		expect(call.oldTurns).toHaveLength(7);
	});

	it("preserves the original user message at index 0 after compaction", async () => {
		const state = buildState();
		const history = buildLongHistory();
		const originalFirst = history[0];

		await maybeCompactConversationHistory(
			state,
			history,
			10,
			95_000,
			100_000,
			"user-1",
		);

		expect(history[0]).toBe(originalFirst);
		expect(history[0].content).toContain("Original task");
	});

	it("replaces middle turns with a single summary block", async () => {
		const state = buildState();
		const history = buildLongHistory();

		await maybeCompactConversationHistory(
			state,
			history,
			10,
			95_000,
			100_000,
			"user-1",
		);

		// New history: [originalUserMsg, summaryMessage, ...6 recent] = 8.
		expect(history).toHaveLength(8);
		expect(history[1].role).toBe("user");
		expect(history[1].content).toContain("CONTEXT SUMMARY");
		expect(history[1].content).toContain("PROGRESS SO FAR");
		expect(history[2].content).toBe("recent-1");
		expect(history[7].content).toBe("recent-6");
	});

	it("mirrors the new history into state.iterativeConversationHistory", async () => {
		const state = buildState();
		const history = buildLongHistory();

		await maybeCompactConversationHistory(
			state,
			history,
			10,
			95_000,
			100_000,
			"user-1",
		);

		expect(state.iterativeConversationHistory).toEqual(history);
		// And it's a copy, not a shared reference.
		expect(state.iterativeConversationHistory).not.toBe(history);
	});

	it("records the compaction's own LLM cost in iterationCosts", async () => {
		const state = buildState();
		const history = buildLongHistory();

		await maybeCompactConversationHistory(
			state,
			history,
			10,
			95_000,
			100_000,
			"user-1",
		);

		expect(state.iterationCosts).toHaveLength(1);
		expect(state.iterationCosts[0]).toMatchObject({
			iteration: 10,
			inputTokens: 1234,
			outputTokens: 567,
		});
	});

	it("updates state.lastCompactionIteration so the cooldown begins", async () => {
		const state = buildState();
		const history = buildLongHistory();

		await maybeCompactConversationHistory(
			state,
			history,
			10,
			95_000,
			100_000,
			"user-1",
		);

		expect(state.lastCompactionIteration).toBe(10);
	});

	it("trims leading tool-result orphans from the recent slice", async () => {
		const state = buildState();
		// Place a tool_call at the boundary so that the recent slice (last 6)
		// starts with the tool_result whose tool_call is the last middle msg.
		const history: IterativeMessage[] = [
			userMsg(),
			assistantText("m1"),
			assistantText("m2"),
			assistantText("m3"),
			assistantText("m4"),
			assistantText("m5"),
			assistantText("m6"),
			assistantToolCall("read_me", "tc-1"), // last middle msg → trimmed as trailing orphan
			toolResult("tc-1"), // first recent msg → trimmed as leading orphan
			assistantText("r2"),
			assistantText("r3"),
			assistantText("r4"),
			assistantText("r5"),
			assistantText("r6"),
		];

		await maybeCompactConversationHistory(
			state,
			history,
			10,
			95_000,
			100_000,
			"user-1",
		);

		// Middle had 7 → 6 after dropping orphan tool_call.
		const call =
			activityStubs.compactConversationHistoryActivity.mock.calls[0][0];
		expect(call.oldTurns).toHaveLength(6);
		expect(call.oldTurns[call.oldTurns.length - 1].role).toBe("assistant");
		expect(
			call.oldTurns[call.oldTurns.length - 1].toolCalls,
		).toBeUndefined();

		// Recent had 6 → 5 after dropping leading orphan tool_result.
		// Final history: [user, summary, r2, r3, r4, r5, r6] = 7.
		expect(history).toHaveLength(7);
		expect(history[2].content).toBe("r2");
	});
});

describe("maybeCompactConversationHistory — failure paths", () => {
	function buildLongHistory(): IterativeMessage[] {
		return [
			userMsg("task"),
			assistantText("m1"),
			assistantText("m2"),
			assistantText("m3"),
			assistantText("m4"),
			assistantText("m5"),
			assistantText("m6"),
			assistantText("m7"),
			assistantText("r1"),
			assistantText("r2"),
			assistantText("r3"),
			assistantText("r4"),
			assistantText("r5"),
			assistantText("r6"),
		];
	}

	it("sets cooldown but does not mutate history when activity throws", async () => {
		activityStubs.compactConversationHistoryActivity.mockRejectedValueOnce(
			new Error("provider down"),
		);
		const state = buildState();
		const history = buildLongHistory();
		const originalLength = history.length;

		await maybeCompactConversationHistory(
			state,
			history,
			10,
			95_000,
			100_000,
			"user-1",
		);

		expect(history).toHaveLength(originalLength);
		expect(state.iterationCosts).toHaveLength(0);
		expect(state.lastCompactionIteration).toBe(10); // cooldown anyway
	});

	it("skips replacement when the activity returns an empty summary", async () => {
		activityStubs.compactConversationHistoryActivity.mockResolvedValueOnce({
			summaryText: "   \n\t  ",
			usage: { inputTokens: 100, outputTokens: 0 },
		});
		const state = buildState();
		const history = buildLongHistory();
		const originalLength = history.length;

		await maybeCompactConversationHistory(
			state,
			history,
			10,
			95_000,
			100_000,
			"user-1",
		);

		expect(history).toHaveLength(originalLength);
		expect(state.iterationCosts).toHaveLength(0);
		expect(state.lastCompactionIteration).toBe(10);
	});
});
