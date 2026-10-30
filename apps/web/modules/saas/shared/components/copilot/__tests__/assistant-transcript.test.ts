import { countHumanMessages } from "@repo/agent-core/reasoning-trace/extract";
import { describe, expect, it } from "vitest";
import {
	captureAssistantTrace,
	findInlineMcpEnvelope,
	selectAgentTurn,
	selectExcludedTurnIds,
	selectTranscriptTrace,
} from "../assistant-transcript";

describe("transcript lookups reserved for transcript wiring", () => {
	const transcript = [
		{ id: "u1", role: "user" },
		{ id: "a1", role: "assistant" },
		{ id: "u2", role: "user" },
		{
			id: "r2",
			type: "ResultMessage",
			role: "tool",
			result: JSON.stringify({
				__fabricMcpRender: {
					resourceUri: "ui://excalidraw/scene",
					configId: "example-config",
				},
			}),
		},
		{ id: "a2", role: "assistant" },
	];
	it("keeps historical turn indices distinct", () => {
		expect(selectAgentTurn(transcript, "a1")).toBe(1);
		expect(selectAgentTurn(transcript, "a2")).toBe(2);
		expect(selectAgentTurn(transcript, "missing")).toBeNull();
		expect(selectAgentTurn(transcript, undefined)).toBeNull();
		expect(selectAgentTurn([], "a2")).toBeNull();
	});
	it("scans only the preceding turn for an MCP envelope", () => {
		expect(findInlineMcpEnvelope({ id: "a1" }, transcript)).toBeNull();
		expect(findInlineMcpEnvelope({ id: "a2" }, transcript)).toMatchObject({
			resourceUri: "ui://excalidraw/scene",
		});
		expect(
			findInlineMcpEnvelope({ id: "pending" }, transcript),
		).toMatchObject({ configId: "example-config" });
		expect(findInlineMcpEnvelope({ id: "a2" }, [])).toBeNull();
	});
	it("counts only user roles in the live transcript and requires a row id", () => {
		const messages = [
			{ role: "user" },
			{ type: "human" },
			{ _getType: () => "human" },
			{ id: "a", role: "assistant" },
		];
		expect(selectAgentTurn(messages, "a")).toBe(1);
		expect(selectAgentTurn(messages, "pending")).toBeNull();
	});
});

it("finds AG-UI tool content only in the reply's turn", () => {
	const envelope = {
		resourceUri: "ui://excalidraw/scene",
		configId: "example-config",
	};
	const transcript = [
		{ id: "greeting", role: "assistant" },
		{ id: "u1", role: "user" },
		{ id: "call", role: "assistant" },
		{
			id: "result",
			role: "tool",
			toolCallId: "tc",
			content: JSON.stringify({ __fabricMcpRender: envelope }),
		},
		{ id: "reply", role: "assistant" },
		{ id: "u2", role: "user" },
		{ id: "reply2", role: "assistant" },
	];
	expect(findInlineMcpEnvelope({ id: "reply" }, transcript)).toEqual(
		envelope,
	);
	expect(findInlineMcpEnvelope({ id: "call" }, transcript)).toBeNull();
	expect(findInlineMcpEnvelope({ id: "reply2" }, transcript)).toBeNull();
	expect(selectAgentTurn(transcript, "reply2")).toBe(2);
});

it("refreshes a mutated tool object's payload in a new transcript snapshot", () => {
	const result = {
		id: "mutable-result",
		role: "tool",
		toolCallId: "call",
		content: JSON.stringify({
			__fabricMcpRender: {
				resourceUri: "ui://excalidraw/old",
				configId: "example-config",
			},
		}),
	};
	const reply = { id: "mutable-reply", role: "assistant" };
	expect(findInlineMcpEnvelope(reply, [result, reply])?.resourceUri).toBe(
		"ui://excalidraw/old",
	);
	result.content = JSON.stringify({
		error: "failed",
		__fabricMcpRender: {
			resourceUri: "ui://excalidraw/new",
			configId: "example-config",
		},
	});
	const next = [result, reply];
	expect(findInlineMcpEnvelope(reply, next)?.resourceUri).toBe(
		"ui://excalidraw/new",
	);
	expect(selectTranscriptTrace(reply, next).results).toEqual({
		call: "success",
	});
});

it.each([
	[{ status: "error", content: "failed" }, "error"],
	[{ content: "Error: failed" }, "error"],
	[{ content: "Error failed" }, "error"],
	[{ error: "error", content: "failed" }, "error"],
	[{ content: '{"error":"data"}' }, "success"],
	[{ content: "done" }, "success"],
])("reconciles backend tool status %j", (fields, status) => {
	const transcript = [
		{ id: "u", role: "user" },
		{ id: "a", role: "assistant" },
		{ id: "r", role: "tool", toolCallId: "tc", ...fields },
	];
	expect(selectTranscriptTrace({ id: "a" }, transcript).results.tc).toBe(
		status,
	);
});

it("matches the agent human count before and after image results", () => {
	const messages = [
		{ id: "u", type: "human" },
		{ id: "a", type: "ai" },
		{
			id: "image",
			type: "human",
			additional_kwargs: { fabricSyntheticToolImage: true },
		},
		{ id: "reply", type: "ai" },
		{ id: "u2", type: "human" },
		{ id: "a2", type: "ai" },
	];
	const transcript = messages.map(({ id, type }) => ({
		id,
		role: type === "human" ? "user" : "assistant",
	}));
	const excluded = selectExcludedTurnIds({ messages });
	for (const id of ["a", "reply", "a2"]) {
		const prefix = messages.slice(
			0,
			messages.findIndex((m) => m.id === id) + 1,
		);
		expect(selectAgentTurn(transcript, id, excluded)).toBe(
			countHumanMessages(prefix as never),
		);
	}
	expect(selectAgentTurn(transcript, "pending", excluded)).toBeNull();
	expect(selectAgentTurn(messages, "missing")).toBeNull();
});

it("merges saved resume snapshots by tool id without dropping earlier tools or moving replacements", () => {
	const search = { id: "search", name: "search", status: "success" };
	const confirm = {
		id: "confirm",
		name: "write_document_local",
		status: "pending",
		startedAt: 1,
	};
	const resolved = {
		id: "confirm",
		name: "write_document_local",
		status: "success",
	};
	const last = { id: "last", name: "read", status: "success" };
	const messages = [
		{ id: "u", role: "user" },
		{
			id: "a1",
			role: "assistant",
			metadata: { fabricAssistantToolTrace: [search, confirm] },
		},
		{
			id: "a2",
			role: "assistant",
			metadata: { fabricAssistantToolTrace: [resolved, last] },
		},
	];
	const trace = selectTranscriptTrace({ id: "a1" }, messages);
	expect(trace.saved.toolCalls).toEqual([search, resolved, last]);
	expect(
		selectTranscriptTrace({ id: "a2" }, messages).saved.toolCalls,
	).toBeNull();
	expect(selectTranscriptTrace({ id: "a1" }, messages).saved).toBe(
		trace.saved,
	);
	const streamed = [
		...messages,
		{ id: "stream", role: "assistant", content: "token" },
	];
	expect(selectTranscriptTrace({ id: "a1" }, streamed).saved).toBe(
		trace.saved,
	);
});

it("uses the latest non-empty saved reasoning and its duration without concatenating snapshots", () => {
	const messages = [
		{ id: "u", role: "user" },
		{
			id: "a1",
			role: "assistant",
			reasoningText: "first run",
			reasoningDurationMs: 1,
		},
		{
			id: "a2",
			role: "assistant",
			reasoningText: "resume run",
			reasoningDurationMs: 2,
		},
		{
			id: "a3",
			role: "assistant",
			reasoningText: "  ",
			reasoningDurationMs: 3,
		},
	];
	const trace = selectTranscriptTrace({ id: "a1" }, messages);
	expect(trace.saved.reasoning).toEqual({
		text: "resume run",
		durationMs: 2,
	});
	expect(selectTranscriptTrace({ id: "a1" }, [...messages]).saved).toBe(
		trace.saved,
	);
});

for (const end of ["completed", "cancelled", "error"] as const) {
	it(`saves unresolved questions as waiting or stopped: ${end}`, () => {
		const messages = [
			{ id: "u", role: "user" },
			{ id: "a", role: "assistant", content: "A question" },
		];
		const captured = captureAssistantTrace(
			"a",
			messages,
			{
				toolCallsByTurn: {
					1: [
						{
							id: "q",
							name: "ask_clarifying_question",
							status: "pending",
						},
					],
				},
			},
			end,
		);
		const saved = selectTranscriptTrace({ id: "a" }, [
			messages[0],
			{ ...messages[1], ...captured },
		]);
		expect(saved.saved.toolCalls?.[0].status).toBe(
			end === "completed" ? "waiting" : "stopped",
		);
	});
}
for (const status of ["success", "error"] as const) {
	it(`reconciles a saved question from parent toolCalls after the next user turn: ${status}`, () => {
		const question = {
			id: "q",
			name: "ask_clarifying_question",
			status: "waiting",
		};
		const messages = [
			{ id: "u", role: "user" },
			{
				id: "a",
				role: "assistant",
				metadata: { fabricAssistantToolTrace: [question] },
				toolCalls: [
					{
						id: "q",
						name: question.name,
						status,
						result:
							status === "error"
								? "Error: rejected"
								: '{"answered":true,"answer":"Yes"}',
					},
				],
			},
			{ id: "u2", role: "user" },
		];
		for (const transcript of [
			messages,
			JSON.parse(JSON.stringify(messages)),
		]) {
			expect(
				selectTranscriptTrace({ id: "a" }, transcript).saved
					.toolCalls?.[0].status,
			).toBe(status);
		}
	});
}
it("uses result evidence before the end reason, including confirmation tools", () => {
	const messages = [
		{ id: "u", role: "user" },
		{ id: "a", role: "assistant" },
		{ id: "r", role: "tool", toolCallId: "c", content: "done" },
	];
	const captured = captureAssistantTrace(
		"a",
		messages,
		{
			toolCallsByTurn: {
				1: [
					{
						id: "c",
						name: "apply_document_patches",
						status: "pending",
					},
				],
			},
		},
		"cancelled",
	);
	expect(
		selectTranscriptTrace({ id: "a" }, [
			messages[0],
			{ ...messages[1], ...captured },
		]).saved.toolCalls?.[0].status,
	).toBe("success");
});

it("keeps an inline confirmation waiting despite its preparation result, then uses the saved verdict", () => {
	const entry = {
		id: "inline",
		name: "write_document_local",
		status: "pending" as const,
	};
	const messages = [
		{ id: "u", role: "user" },
		{
			id: "a",
			role: "assistant",
			content: "Review",
			toolCalls: [
				{
					id: "confirm",
					function: {
						name: "confirm_changes",
						arguments: JSON.stringify({
							__inlineTool: { id: "inline", name: entry.name },
						}),
					},
				},
			],
		},
		{
			id: "r",
			role: "tool",
			toolCallId: "inline",
			content: "Document written.",
		},
	];
	const captured = captureAssistantTrace(
		"a",
		messages,
		{ toolCallsByTurn: { 1: [entry] } },
		"completed",
	);
	const saved = [messages[0], { ...messages[1], ...captured }, messages[2]];
	expect(
		selectTranscriptTrace({ id: "a" }, saved).saved.toolCalls?.[0].status,
	).toBe("waiting");
	for (const accepted of [true, false]) {
		const answered = [
			...saved,
			{
				id: "answer",
				role: "tool",
				toolCallId: "confirm",
				content: JSON.stringify({ accepted }),
			},
		];
		expect(
			selectTranscriptTrace({ id: "a" }, answered).saved.toolCalls?.[0]
				.status,
		).toBe(accepted ? "success" : "error");
	}

	for (const status of ["success", "error"] as const) {
		expect(
			selectTranscriptTrace({ id: "a" }, [
				...saved,
				{
					id: "verdict",
					role: "assistant",
					metadata: {
						fabricAssistantToolTrace: [{ ...entry, status }],
					},
				},
			]).saved.toolCalls?.[0].status,
		).toBe(status);
	}
});
