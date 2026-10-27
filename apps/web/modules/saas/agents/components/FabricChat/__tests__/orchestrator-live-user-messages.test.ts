import { describe, expect, it } from "vitest";
import {
	selectLiveStoppedAssistantMessages,
	selectLiveUserMessages,
	stoppedAnswerText,
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

describe("selectLiveStoppedAssistantMessages", () => {
	const stoppedFirstTurn = [
		{ id: "u1", role: "user", content: "q1" },
		{
			id: "a1",
			role: "assistant",
			content: "partial",
			streamStatus: "cancelled",
		},
	];

	it("shows the stopped answer while its turn is live", () => {
		expect(
			selectLiveStoppedAssistantMessages(stoppedFirstTurn, []).map(
				(m) => m.id,
			),
		).toEqual(["a1"]);
	});

	it("leaves the stopped answer to its completed entry once a later question runs", () => {
		const messages = [
			...stoppedFirstTurn,
			{ id: "u2", role: "user", content: "q2" },
			{
				id: "a2",
				role: "assistant",
				content: "",
				streamStatus: "streaming",
			},
		];
		expect(
			selectLiveStoppedAssistantMessages(messages, [
				completed("exec_1", "q1", "u1"),
			]),
		).toEqual([]);
	});

	it("keeps the live turn's stopped answer when a clarification answer follows it", () => {
		const messages = [
			{ id: "u2", role: "user", content: "q2" },
			{
				id: "a2",
				role: "assistant",
				content: "partial",
				streamStatus: "cancelled",
			},
			{ id: "c2", role: "user", content: "Clarification — which?: this" },
		];
		expect(
			selectLiveStoppedAssistantMessages(messages, [
				completed("exec_1", "q1", "u1"),
			]).map((m) => m.id),
		).toEqual(["a2"]);
	});
});

describe("stoppedAnswerText", () => {
	it("returns the latest assistant message's text when it was stopped", () => {
		expect(
			stoppedAnswerText([
				{ role: "user", content: "q" },
				{
					role: "assistant",
					content: "partial",
					streamStatus: "cancelled",
				},
			]),
		).toBe("partial");
	});

	it("ignores an earlier turn's stopped answer and an empty stop", () => {
		expect(
			stoppedAnswerText([
				{
					role: "assistant",
					content: "old",
					streamStatus: "cancelled",
				},
				{ role: "user", content: "q" },
				{ role: "assistant", content: "  ", streamStatus: "cancelled" },
			]),
		).toBeUndefined();
		expect(
			stoppedAnswerText([
				{
					role: "assistant",
					content: "old",
					streamStatus: "cancelled",
				},
				{
					role: "assistant",
					content: "done",
					streamStatus: "completed",
				},
			]),
		).toBeUndefined();
	});
});

it("leaves completed clarification exchanges to their execution", () => {
	const messages = [
		{ id: "question", role: "user" },
		{
			id: "clarification",
			role: "user",
			metadata: {
				clarification: { question: "Which branch?", answer: "staging" },
			},
		},
	];
	expect(
		selectLiveUserMessages(messages, [
			{
				id: "execution",
				userMessage: "Check branch",
				userMessageId: "question",
				stepResults: [],
				completedAt: new Date(),
			},
		]),
	).toEqual([]);
});
