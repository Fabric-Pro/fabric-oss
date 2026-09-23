import { describe, expect, it } from "vitest";
import {
	selectLiveUserMessages,
	turnQuestionMessageId,
} from "../orchestrator/live-user-messages";
import type { CompletedExecution } from "../orchestrator/types";

function completed(
	id: string,
	userMessage: string,
	userMessageId?: string,
): CompletedExecution {
	return {
		id,
		userMessage,
		userMessageId,
		stepResults: [],
		completedAt: new Date(),
	};
}

describe("selectLiveUserMessages (#2040 F31)", () => {
	const messages = [
		{ id: "u1", role: "user", content: "summarize the roadmap" },
		{ id: "a1", role: "assistant", content: "…" },
		{ id: "u2", role: "user", content: "summarize the roadmap" },
		{ id: "a2", role: "assistant", content: "" },
	];

	it("shows a repeated question while it runs", () => {
		const live = selectLiveUserMessages(messages, [
			completed("exec_1", "summarize the roadmap", "u1"),
		]);

		expect(live.map((m) => m.id)).toEqual(["u2"]);
	});

	it("does not hide a new question that repeats a restored turn's text", () => {
		const live = selectLiveUserMessages(
			[{ id: "u9", role: "user", content: "summarize the roadmap" }],
			[completed("exec_old", "summarize the roadmap")],
		);

		expect(live.map((m) => m.id)).toEqual(["u9"]);
	});

	it("skips assistant messages and tolerates empty entries", () => {
		expect(
			selectLiveUserMessages(messages, [null, undefined]).map(
				(m) => m.id,
			),
		).toEqual(["u1", "u2"]);
	});
});

describe("turnQuestionMessageId", () => {
	it("claims the turn's question, not a follow-up sent while it ran", () => {
		const messages = [
			{ id: "u1", role: "user", content: "summarize the roadmap" },
			{ id: "a1", role: "assistant", content: "…" },
			{ id: "u2", role: "user", content: "summarize the roadmap " },
			{ id: "a2", role: "assistant", content: "" },
			{ id: "f1", role: "user", content: "focus on Q3" },
		];

		expect(turnQuestionMessageId(messages, "summarize the roadmap")).toBe(
			"u2",
		);
	});

	it("falls back to the newest user message", () => {
		expect(
			turnQuestionMessageId(
				[
					{ id: "u1", role: "user", content: "first" },
					{ id: "a1", role: "assistant", content: "" },
				],
				"something else",
			),
		).toBe("u1");
		expect(turnQuestionMessageId([], "anything")).toBeUndefined();
	});
});
