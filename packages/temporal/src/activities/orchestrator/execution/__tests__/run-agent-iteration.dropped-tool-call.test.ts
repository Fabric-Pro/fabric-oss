/**
 * runAgentIteration dropped tool-call guard — activity unit tests.
 *
 * Locks the guard that classifies a provider stream defect as a transient
 * error instead of a fabricated success: when `finishReason` resolves to
 * `"tool-calls"` (the model stopped in order to call a tool) but zero
 * `tool-call` parts actually surfaced through `fullStream` (observed on the
 * Databricks provider dropping a `tool_use` block — staging execution
 * orch-9294c339, 2026-07-27), the activity must NOT fall through to the
 * "no tool calls -> final response" branch and return the collected preamble
 * text as a successful answer. Instead:
 *
 *   1. The existing in-activity retry (`MAX_STREAM_ATTEMPTS = 2`) re-rolls
 *      the call once, and succeeds if the re-roll streams a real tool call.
 *   2. If the defect persists across both attempts, the existing Path B
 *      returns `{ type: "stream_error" }` — never a `"response"` — so the
 *      workflow surfaces a visible failure instead of silently poisoning
 *      conversation history with an empty stub.
 *   3. Normal completions (finishReason "stop", or genuine tool calls) are
 *      untouched by the guard, WITH or WITHOUT tools bound — an unbound-tools
 *      call reporting finishReason=tool-calls is an even stronger protocol
 *      inconsistency, not an exemption.
 *
 * Also locks the attempt-failure hardening added alongside the guard:
 *   - An `invalid` tool-call part (AI SDK's DynamicToolCall marks unparsable/
 *     unknown calls this way instead of throwing) fails the whole turn, even
 *     when other calls in the same turn are valid — a corrupted turn is not
 *     partially salvageable.
 *   - A `tool-error` part is classified the same way.
 *   - `finishReason === "error"` with no `error` part is classified as a
 *     stream_error too.
 *   - Usage is aggregated across ALL attempts (not just the last one), since
 *     a failed-then-retried attempt still burns real provider tokens.
 *   - `stream.usage` and `stream.finishReason` rejecting simultaneously is
 *     handled via `Promise.allSettled` without an unhandled rejection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted` runs before any module imports so the captured stubs are
// installed when `@repo/ai`'s top-level evaluation happens. Without this,
// `streamText` would still be the real implementation when the activity
// module first imports it.
const aiStubs = vi.hoisted(() => {
	const streamTextMock = vi.fn();
	return {
		streamTextMock,
		// Tool definition factory — the activity calls `tool(...)` per
		// entry in `availableTools`. We return an opaque object whose only
		// purpose is to be re-found by name in `streamText.tools`.
		toolMock: vi.fn((definition: { description?: string }) => ({
			__isAiSdkTool: true,
			description: definition?.description,
		})),
		jsonSchemaMock: vi.fn((schema: unknown) => ({
			__isJsonSchema: true,
			schema,
		})),
		stepCountIsMock: vi.fn((n: number) => ({ __stopWhen: "stepCount", n })),
	};
});

vi.mock("@repo/ai", () => ({
	streamText: aiStubs.streamTextMock,
	tool: aiStubs.toolMock,
	jsonSchema: aiStubs.jsonSchemaMock,
	stepCountIs: aiStubs.stepCountIsMock,
}));

vi.mock("@repo/ai/limits", () => ({
	classifyLimitError: vi.fn(() => null),
}));

vi.mock("@repo/ai/skills", () => ({
	listAvailableSkills: vi.fn(async () => []),
	createSkillTools: vi.fn(() => ({})),
	buildSkillsSystemBlock: vi.fn(() => ""),
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
}));

vi.mock("../../../../lib/redis-publisher", () => ({
	publishExecutionEvent: vi.fn(),
}));

vi.mock("../../utils", () => ({
	getAiModel: vi.fn(async () => ({ __mockModel: true })),
}));

import {
	type RunAgentIterationInput,
	runAgentIteration,
} from "../run-agent-iteration";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A `streamText` return value shaped enough to satisfy the activity's
 * consumer logic: a `fullStream` async iterable yielding the given parts,
 * plus `usage`/`finishReason` promises. By default both fulfill (usage
 * 10/5 input/output tokens, finishReason "stop"); pass `usageError` /
 * `finishReasonError` to make either reject instead (raw rejected promises —
 * the production code's `Promise.allSettled` is what must handle them, not
 * a pre-attached `.catch` here).
 */
function makeStreamResult(opts: {
	parts?: Array<Record<string, unknown>>;
	finishReason?: string;
	usageError?: unknown;
	finishReasonError?: unknown;
}) {
	return {
		fullStream: (async function* () {
			for (const part of opts.parts ?? []) {
				yield part;
			}
		})(),
		usage:
			opts.usageError !== undefined
				? Promise.reject(opts.usageError)
				: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
		finishReason:
			opts.finishReasonError !== undefined
				? Promise.reject(opts.finishReasonError)
				: Promise.resolve(opts.finishReason ?? "stop"),
	};
}

function buildInput(
	overrides: Partial<RunAgentIterationInput> = {},
): RunAgentIterationInput {
	return {
		conversationHistory: [
			{
				role: "user",
				content: "Plain prompt with no frame trigger phrases.",
				timestamp: "2026-05-04T00:00:00.000Z",
			},
		],
		availableTools: {
			create_view: {
				description: "Create an Excalidraw view.",
				inputSchema: { type: "object", properties: {} },
			},
		},
		systemPrompt: "You are a helpful agent.",
		userId: "user-1",
		organizationId: "org-1",
		executionId: "exec-1",
		iteration: 1,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("runAgentIteration — dropped tool-call guard", () => {
	it("retries once when finishReason=tool-calls arrives with zero tool-call parts, and succeeds on the re-roll", async () => {
		aiStubs.streamTextMock
			.mockImplementationOnce(() =>
				makeStreamResult({
					parts: [{ type: "text-delta", text: "Let me check." }],
					finishReason: "tool-calls",
				}),
			)
			.mockImplementationOnce(() =>
				makeStreamResult({
					parts: [
						{
							type: "tool-call",
							toolCallId: "tc-1",
							toolName: "create_view",
							input: { a: 1 },
						},
					],
					finishReason: "tool-calls",
				}),
			);

		const result = await runAgentIteration(buildInput());

		expect(aiStubs.streamTextMock).toHaveBeenCalledTimes(2);
		expect(result.type).toBe("tool_calls");
		// Usage aggregates across BOTH attempts (10/5 each), not just the
		// successful re-roll — the failed first attempt still burned tokens.
		expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
		if (result.type === "tool_calls") {
			expect(result.toolCalls[0].name).toBe("create_view");
			expect(result.toolCalls[0].args).toEqual({ a: 1 });
		}
	});

	it("returns stream_error (not a fabricated response) when the defect persists across both attempts", async () => {
		aiStubs.streamTextMock
			.mockImplementationOnce(() =>
				makeStreamResult({
					parts: [{ type: "text-delta", text: "Let me check." }],
					finishReason: "tool-calls",
				}),
			)
			.mockImplementationOnce(() =>
				makeStreamResult({
					parts: [
						{ type: "text-delta", text: "Let me check again." },
					],
					finishReason: "tool-calls",
				}),
			);

		const result = await runAgentIteration(buildInput());

		expect(aiStubs.streamTextMock).toHaveBeenCalledTimes(2);
		expect(result.type).toBe("stream_error");
		expect(result.type).not.toBe("response");
		// Both defective attempts still fulfilled usage (10/5 each) — the
		// aggregate must be preserved even on the failure path.
		expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
		if (result.type === "stream_error") {
			expect(result.message).toContain("tool-call");
		}
	});

	it("normal final response is untouched by the guard", async () => {
		aiStubs.streamTextMock.mockImplementationOnce(() =>
			makeStreamResult({
				parts: [{ type: "text-delta", text: "All done." }],
				finishReason: "stop",
			}),
		);

		const result = await runAgentIteration(buildInput());

		expect(aiStubs.streamTextMock).toHaveBeenCalledTimes(1);
		expect(result.type).toBe("response");
		if (result.type === "response") {
			expect(result.content).toBe("All done.");
		}
	});

	it("guard fires even when no tools are bound — finishReason=tool-calls with zero parts is a stronger protocol inconsistency, not an exemption", async () => {
		aiStubs.streamTextMock
			.mockImplementationOnce(() =>
				makeStreamResult({
					parts: [{ type: "text-delta", text: "Hi." }],
					finishReason: "tool-calls",
				}),
			)
			.mockImplementationOnce(() =>
				makeStreamResult({
					parts: [{ type: "text-delta", text: "Hi again." }],
					finishReason: "tool-calls",
				}),
			);

		const result = await runAgentIteration(
			buildInput({ availableTools: {} }),
		);

		expect(aiStubs.streamTextMock).toHaveBeenCalledTimes(2);
		expect(result.type).toBe("stream_error");
	});

	it("normal final response with no tools bound at all is untouched by the guard", async () => {
		aiStubs.streamTextMock.mockImplementationOnce(() =>
			makeStreamResult({
				parts: [
					{ type: "text-delta", text: "All done, no tools needed." },
				],
				finishReason: "stop",
			}),
		);

		const result = await runAgentIteration(
			buildInput({ availableTools: {} }),
		);

		expect(aiStubs.streamTextMock).toHaveBeenCalledTimes(1);
		expect(result.type).toBe("response");
		if (result.type === "response") {
			expect(result.content).toBe("All done, no tools needed.");
		}
	});

	it("returns stream_error when the provider reports an invalid tool call on both attempts, and nothing is enqueued", async () => {
		const invalidPart = () => ({
			type: "tool-call",
			toolCallId: "tc-x",
			toolName: "create_view",
			input: {},
			invalid: true,
			error: "malformed JSON",
		});
		aiStubs.streamTextMock
			.mockImplementationOnce(() =>
				makeStreamResult({
					parts: [invalidPart()],
					finishReason: "tool-calls",
				}),
			)
			.mockImplementationOnce(() =>
				makeStreamResult({
					parts: [invalidPart()],
					finishReason: "tool-calls",
				}),
			);

		const result = await runAgentIteration(buildInput());

		expect(aiStubs.streamTextMock).toHaveBeenCalledTimes(2);
		expect(result.type).toBe("stream_error");
		if (result.type === "stream_error") {
			expect(result.message).toContain("invalid tool call");
		}
	});

	it("fails a mixed turn (valid + invalid tool calls) whole, retries, and returns only the valid re-rolled call", async () => {
		aiStubs.streamTextMock
			.mockImplementationOnce(() =>
				makeStreamResult({
					parts: [
						{
							type: "tool-call",
							toolCallId: "tc-valid-1",
							toolName: "create_view",
							input: { a: 1 },
						},
						{
							type: "tool-call",
							toolCallId: "tc-invalid-1",
							toolName: "create_view",
							input: {},
							invalid: true,
							error: "malformed JSON",
						},
					],
					finishReason: "tool-calls",
				}),
			)
			.mockImplementationOnce(() =>
				makeStreamResult({
					parts: [
						{
							type: "tool-call",
							toolCallId: "tc-valid-2",
							toolName: "create_view",
							input: { a: 2 },
						},
					],
					finishReason: "tool-calls",
				}),
			);

		const result = await runAgentIteration(buildInput());

		expect(aiStubs.streamTextMock).toHaveBeenCalledTimes(2);
		expect(result.type).toBe("tool_calls");
		if (result.type === "tool_calls") {
			// The valid call from the FAILED first attempt must not leak
			// through — only the clean re-roll's call is returned.
			expect(result.toolCalls).toHaveLength(1);
			expect(result.toolCalls[0].id).toBe("tc-valid-2");
		}
	});

	it("fails the turn on a tool-error part, retries, and succeeds on the clean re-roll", async () => {
		aiStubs.streamTextMock
			.mockImplementationOnce(() =>
				makeStreamResult({
					parts: [
						{
							type: "tool-call",
							toolCallId: "tc-1",
							toolName: "create_view",
							input: { a: 1 },
						},
						{
							type: "tool-error",
							toolCallId: "tc-1",
							toolName: "create_view",
							error: "input validation failed",
						},
					],
					finishReason: "tool-calls",
				}),
			)
			.mockImplementationOnce(() =>
				makeStreamResult({
					parts: [
						{
							type: "tool-call",
							toolCallId: "tc-2",
							toolName: "create_view",
							input: { a: 2 },
						},
					],
					finishReason: "tool-calls",
				}),
			);

		const result = await runAgentIteration(buildInput());

		expect(aiStubs.streamTextMock).toHaveBeenCalledTimes(2);
		expect(result.type).toBe("tool_calls");
		if (result.type === "tool_calls") {
			expect(result.toolCalls).toHaveLength(1);
			expect(result.toolCalls[0].id).toBe("tc-2");
		}
	});

	it("returns stream_error when finishReason=error arrives with only text and no error part, on both attempts", async () => {
		aiStubs.streamTextMock
			.mockImplementationOnce(() =>
				makeStreamResult({
					parts: [
						{
							type: "text-delta",
							text: "Something went wrong internally.",
						},
					],
					finishReason: "error",
				}),
			)
			.mockImplementationOnce(() =>
				makeStreamResult({
					parts: [{ type: "text-delta", text: "Still broken." }],
					finishReason: "error",
				}),
			);

		const result = await runAgentIteration(buildInput());

		expect(aiStubs.streamTextMock).toHaveBeenCalledTimes(2);
		expect(result.type).toBe("stream_error");
		if (result.type === "stream_error") {
			expect(result.message).toContain("finishReason=error");
		}
	});

	it("handles stream.usage AND stream.finishReason both rejecting without crashing (Path A, transient retry applies)", async () => {
		aiStubs.streamTextMock
			.mockImplementationOnce(() =>
				makeStreamResult({
					parts: [{ type: "text-delta", text: "..." }],
					usageError: new Error("stream terminated unexpectedly"),
					finishReasonError: new Error(
						"stream terminated unexpectedly",
					),
				}),
			)
			.mockImplementationOnce(() =>
				makeStreamResult({
					parts: [{ type: "text-delta", text: "..." }],
					usageError: new Error("stream terminated unexpectedly"),
					finishReasonError: new Error(
						"stream terminated unexpectedly",
					),
				}),
			);

		const result = await runAgentIteration(buildInput());

		expect(aiStubs.streamTextMock).toHaveBeenCalledTimes(2);
		expect(result.type).toBe("stream_error");
	});
});
