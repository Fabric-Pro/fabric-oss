import { describe, expect, it } from "vitest";
import {
	dropDuplicatedOperationResults,
	findToolCallIndex,
	isConversationSwitch,
	settleUnfinishedToolCalls,
	trimHistoryForRequest,
} from "../direct-chat-turns";

/** Direct chat turn helpers — Fizzy #2040 review F11, F12, F27, F32, F33. */

const op = (content = "SYSTEM\n\nanswer") => ({
	role: "system",
	content,
	metadata: { kind: "operation_result", outcome: "success" },
});

describe("dropDuplicatedOperationResults (F33)", () => {
	it("drops the row when the exchange already has the saved answer, in either order", () => {
		const messages = [
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
			op(),
			{ role: "user", content: "q2" },
			op(),
			{ role: "assistant", content: "a2" },
		];

		expect(
			dropDuplicatedOperationResults(messages).map((m) => m.content),
		).toEqual(["q1", "a1", "q2", "a2"]);
	});

	it("keeps the row when it is the only record of the answer", () => {
		// The tab closed before the browser could save the reply.
		const messages = [
			{ role: "user", content: "q1" },
			op("SYSTEM\n\nthe only answer"),
			{ role: "user", content: "q2" },
		];

		expect(dropDuplicatedOperationResults(messages)).toHaveLength(3);
	});

	it("leaves other system rows alone", () => {
		const messages = [
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
			{ role: "system", content: "note", metadata: { kind: "other" } },
		];

		expect(dropDuplicatedOperationResults(messages)).toHaveLength(3);
	});
});

describe("trimHistoryForRequest (F32)", () => {
	const exchanges = (count: number) =>
		Array.from({ length: count * 2 }, (_, i) => ({
			role: i % 2 === 0 ? "user" : "assistant",
			content: `m${i}`,
		}));

	it("leaves a short thread untouched", () => {
		const history = exchanges(3);
		expect(trimHistoryForRequest(history)).toEqual(history);
	});

	it("keeps the most recent window, starting on a question", () => {
		const trimmed = trimHistoryForRequest(exchanges(150));
		expect(trimmed.length).toBeLessThanOrEqual(200);
		expect(trimmed[0].role).toBe("user");
		expect(trimmed.at(-1)?.content).toBe("m299");
	});

	it("keeps leading context rows pinned", () => {
		const trimmed = trimHistoryForRequest([
			{ role: "system", content: "context" },
			...exchanges(150),
		]);
		expect(trimmed[0].content).toBe("context");
		expect(trimmed[1].role).toBe("user");
		expect(trimmed.length).toBeLessThanOrEqual(200);
	});
});

describe("findToolCallIndex (F12)", () => {
	const calls = [
		{ id: "c1", name: "search", status: "running" },
		{ id: "c2", name: "search", status: "running" },
	];

	it("matches by id", () => {
		expect(
			findToolCallIndex(calls, { toolCallId: "c2", toolName: "search" }),
		).toBe(1);
	});

	it("does not fall back to the name when the id is unknown", () => {
		expect(
			findToolCallIndex(calls, { toolCallId: "c9", toolName: "search" }),
		).toBe(-1);
	});

	it("refuses an ambiguous name-only match", () => {
		expect(findToolCallIndex(calls, { toolName: "search" })).toBe(-1);
	});
});

describe("settleUnfinishedToolCalls (F11)", () => {
	it("settles only open calls and keeps their own error", () => {
		const settled = settleUnfinishedToolCalls([
			{ status: "complete" },
			{ status: "running" },
			{ status: "pending", error: "own reason" },
		]);
		expect(settled?.map((tc) => tc.status)).toEqual([
			"complete",
			"error",
			"error",
		]);
		expect(settled?.[2].error).toBe("own reason");
	});

	it("returns the same array when nothing is open", () => {
		const calls = [{ status: "complete" }];
		expect(settleUnfinishedToolCalls(calls)).toBe(calls);
	});
});

describe("isConversationSwitch (F27)", () => {
	it("is a switch when the user opens a different conversation", () => {
		expect(
			isConversationSwitch({
				externalConversationId: "B",
				currentConversationId: "A",
				ownCreatedConversationId: null,
			}),
		).toBe(true);
	});

	it("is not a switch when the URL receives the chat's own new conversation", () => {
		expect(
			isConversationSwitch({
				externalConversationId: "N",
				currentConversationId: null,
				ownCreatedConversationId: "N",
			}),
		).toBe(false);
	});

	it("is not a switch when nothing is selected", () => {
		expect(
			isConversationSwitch({
				externalConversationId: null,
				currentConversationId: "A",
				ownCreatedConversationId: null,
			}),
		).toBe(false);
	});
});

describe("trimHistoryForRequest — payload size (F32)", () => {
	it("drops the oldest entries until the whole history fits the request budget", () => {
		const big = Array.from({ length: 20 }, (_, i) => ({
			role: i % 2 === 0 ? "user" : "assistant",
			content: `${i}`.padEnd(150_000, "x"),
		}));

		const trimmed = trimHistoryForRequest(big);
		const total = trimmed.reduce((sum, e) => sum + e.content.length, 0);

		expect(total).toBeLessThanOrEqual(1_000_000);
		expect(trimmed[0].role).toBe("user");
		expect(trimmed.at(-1)?.content.startsWith("19")).toBe(true);
	});
});
