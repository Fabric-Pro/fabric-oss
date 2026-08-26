import {
	AIMessage,
	AIMessageChunk,
	HumanMessage,
} from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import {
	buildReasoningUpdate,
	countHumanMessages,
	extractReasoningFromContent,
	extractReasoningFromMessage,
	extractReasoningTokens,
	extractTextFromContent,
	reasoningByTurnAnnotation,
	stripRawResponseEnvelope,
} from "../src/reasoning-trace";

// ============================================================================
// extractTextFromContent (migrated from project-document-generator)
// ============================================================================

describe("extractTextFromContent", () => {
	it("returns string content unchanged", () => {
		expect(extractTextFromContent("plain string")).toBe("plain string");
	});

	it("extracts text blocks from multi-block array", () => {
		const content = [
			{ type: "thinking", thinking: "ignored" },
			{ type: "text", text: "Hello " },
			{ type: "text", text: "world" },
		];
		expect(extractTextFromContent(content)).toBe("Hello world");
	});

	it("ignores reasoning + thinking blocks in mixed content", () => {
		const content = [
			{ type: "thinking", thinking: "internal" },
			{ type: "reasoning", reasoning: "internal" },
			{ type: "text", text: "visible" },
		];
		expect(extractTextFromContent(content)).toBe("visible");
	});

	it("returns empty string for array of only thinking blocks", () => {
		const content = [{ type: "thinking", thinking: "only thoughts" }];
		expect(extractTextFromContent(content)).toBe("");
	});

	it("returns empty string for null/undefined", () => {
		expect(extractTextFromContent(null)).toBe("");
		expect(extractTextFromContent(undefined)).toBe("");
	});

	it("ignores blocks with non-string text fields", () => {
		const content = [
			{ type: "text", text: 42 },
			{ type: "text" },
			{ type: "text", text: "valid" },
		];
		expect(extractTextFromContent(content)).toBe("valid");
	});
});

// ============================================================================
// countHumanMessages
// ============================================================================

describe("countHumanMessages", () => {
	it("counts LangChain class instances via _getType()", () => {
		const messages = [
			new HumanMessage("first user"),
			new AIMessage("assistant reply"),
			new HumanMessage("second user"),
		];
		expect(countHumanMessages(messages as never)).toBe(2);
	});

	it("counts plain objects with type === 'human' (LangGraph deserialized)", () => {
		const messages = [
			{ type: "human", content: "x" },
			{ type: "ai", content: "y" },
			{ type: "human", content: "z" },
		];
		expect(countHumanMessages(messages as never)).toBe(2);
	});

	it("counts plain objects with role === 'user' (OpenAI / AG-UI format)", () => {
		const messages = [
			{ role: "user", content: "x" },
			{ role: "assistant", content: "y" },
		];
		expect(countHumanMessages(messages as never)).toBe(1);
	});

	it("returns 0 for empty array", () => {
		expect(countHumanMessages([])).toBe(0);
	});

	it("returns 0 when no human messages present", () => {
		expect(countHumanMessages([new AIMessage("only ai")] as never)).toBe(0);
	});
});

// ============================================================================
// extractReasoningFromContent
// ============================================================================

describe("extractReasoningFromContent", () => {
	it("extracts Anthropic thinking blocks", () => {
		const content = [
			{ type: "thinking", thinking: "Let me analyze..." },
			{ type: "thinking", thinking: " the document." },
			{ type: "text", text: "Based on..." },
		];
		expect(extractReasoningFromContent(content)).toBe(
			"Let me analyze... the document.",
		);
	});

	it("extracts OpenAI reasoning blocks", () => {
		const content = [
			{ type: "reasoning", reasoning: "Thinking step 1" },
			{ type: "text", text: "Answer" },
		];
		expect(extractReasoningFromContent(content)).toBe("Thinking step 1");
	});

	it("handles mixed thinking + reasoning blocks (shouldn't happen but be safe)", () => {
		const content = [
			{ type: "thinking", thinking: "A" },
			{ type: "reasoning", reasoning: "B" },
		];
		expect(extractReasoningFromContent(content)).toBe("AB");
	});

	it("returns empty string for string content (no thinking)", () => {
		expect(extractReasoningFromContent("plain text")).toBe("");
	});

	it("returns empty string when array has no thinking/reasoning blocks", () => {
		const content = [{ type: "text", text: "only text" }];
		expect(extractReasoningFromContent(content)).toBe("");
	});

	it("ignores blocks with wrong types or missing fields", () => {
		const content = [
			{ type: "thinking" },
			{ type: "thinking", thinking: 42 },
			{ type: "thinking", thinking: "valid" },
		];
		expect(extractReasoningFromContent(content)).toBe("valid");
	});

	it("handles null/undefined content", () => {
		expect(extractReasoningFromContent(null)).toBe("");
		expect(extractReasoningFromContent(undefined)).toBe("");
	});
});

// ============================================================================
// extractReasoningFromMessage
// ============================================================================

describe("extractReasoningFromMessage", () => {
	it("returns content[]-extracted reasoning when thinking blocks are present (ANTHROPIC_DIRECT path)", () => {
		const msg = new AIMessage({
			content: [
				{ type: "thinking", thinking: "let me think about scaling..." },
				{ type: "text", text: "Here's the answer." },
			] as never,
		});
		expect(extractReasoningFromMessage(msg)).toBe(
			"let me think about scaling...",
		);
	});

	it("returns content[]-extracted reasoning when reasoning blocks are present (OPENAI_DIRECT path)", () => {
		const msg = new AIMessage({
			content: [
				{ type: "reasoning", reasoning: "step 1: analyze..." },
				{ type: "text", text: "Answer is 42." },
			] as never,
		});
		expect(extractReasoningFromMessage(msg)).toBe("step 1: analyze...");
	});

	it("falls back to additional_kwargs.__raw_response.choices[0].message.reasoning when content has no blocks (GATEWAY path)", () => {
		const msg = new AIMessage({
			content: "The capital of France is Paris.",
			additional_kwargs: {
				__raw_response: {
					choices: [
						{
							message: {
								content: "The capital of France is Paris.",
								reasoning:
									"The user asked for the capital of France. France's capital is Paris.",
							},
						},
					],
				},
			},
		});
		expect(extractReasoningFromMessage(msg)).toBe(
			"The user asked for the capital of France. France's capital is Paris.",
		);
	});

	it("returns empty string when neither content[] blocks nor __raw_response carry reasoning", () => {
		const msg = new AIMessage({ content: "Just an answer, no reasoning." });
		expect(extractReasoningFromMessage(msg)).toBe("");
	});

	it("returns empty string when __raw_response is malformed (missing choices array)", () => {
		const msg = new AIMessage({
			content: "Answer.",
			additional_kwargs: {
				__raw_response: { id: "chatcmpl-xyz" } as unknown,
			},
		});
		expect(extractReasoningFromMessage(msg)).toBe("");
	});

	it("prefers content[] over __raw_response when both are present (consistency with native paths)", () => {
		const msg = new AIMessage({
			content: [
				{ type: "thinking", thinking: "native thinking text" },
				{ type: "text", text: "Answer." },
			] as never,
			additional_kwargs: {
				__raw_response: {
					choices: [
						{
							message: {
								content: "Answer.",
								reasoning: "raw reasoning text",
							},
						},
					],
				},
			},
		});
		expect(extractReasoningFromMessage(msg)).toBe("native thinking text");
	});

	it("falls back to choices[0].delta.reasoning when message field is absent (STREAMING gateway path)", () => {
		const msg = new AIMessage({
			content: "Here are 3 scaling recommendations.",
			additional_kwargs: {
				__raw_response: {
					choices: [
						{
							index: 0,
							delta: {
								role: "assistant",
								content: "Here are 3 scaling recommendations.",
								reasoning:
									"Let me reason through this: connection pooling matters most for hot paths because…",
							},
						},
					],
				},
			},
		});
		expect(extractReasoningFromMessage(msg)).toBe(
			"Let me reason through this: connection pooling matters most for hot paths because…",
		);
	});

	it("prefers message.reasoning over delta.reasoning when both are present", () => {
		const msg = new AIMessage({
			content: "Answer.",
			additional_kwargs: {
				__raw_response: {
					choices: [
						{
							index: 0,
							message: {
								content: "Answer.",
								reasoning: "from message",
							},
							delta: { reasoning: "from delta" },
						},
					],
				},
			},
		});
		expect(extractReasoningFromMessage(msg)).toBe("from message");
	});

	it("warns when message.reasoning and delta.reasoning are non-empty but disagree", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const msg = new AIMessage({
				content: "Answer.",
				additional_kwargs: {
					__raw_response: {
						choices: [
							{
								index: 0,
								message: { reasoning: "canonical" },
								delta: { reasoning: "diverged" },
							},
						],
					},
				},
			});
			expect(extractReasoningFromMessage(msg)).toBe("canonical");
			expect(warnSpy).toHaveBeenCalledOnce();
			expect(warnSpy.mock.calls[0][0]).toMatch(
				/divergent reasoning text/i,
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("does NOT warn when message and delta agree (no false-positive telemetry)", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const msg = new AIMessage({
				content: "Answer.",
				additional_kwargs: {
					__raw_response: {
						choices: [
							{
								index: 0,
								message: { reasoning: "same" },
								delta: { reasoning: "same" },
							},
						],
					},
				},
			});
			expect(extractReasoningFromMessage(msg)).toBe("same");
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("returns '' when delta.reasoning is an empty string", () => {
		const msg = new AIMessage({
			content: "Answer.",
			additional_kwargs: {
				__raw_response: {
					choices: [{ index: 0, delta: { reasoning: "" } }],
				},
			},
		});
		expect(extractReasoningFromMessage(msg)).toBe("");
	});

	it("returns '' when delta.reasoning is non-string (null/number/object)", () => {
		const cases: unknown[] = [null, 42, { unexpected: "shape" }, []];
		for (const reasoningValue of cases) {
			const msg = new AIMessage({
				content: "Answer.",
				additional_kwargs: {
					__raw_response: {
						choices: [
							{ index: 0, delta: { reasoning: reasoningValue } },
						],
					},
				},
			});
			expect(extractReasoningFromMessage(msg)).toBe("");
		}
	});

	it("real LangChain AIMessageChunk.concat merges delta.reasoning across chunks (regression guard)", () => {
		const chunk1 = new AIMessageChunk({
			content: "Hello ",
			additional_kwargs: {
				__raw_response: {
					choices: [
						{
							index: 0,
							delta: { role: "assistant", reasoning: "first " },
						},
					],
				},
			},
		});
		const chunk2 = new AIMessageChunk({
			content: "world",
			additional_kwargs: {
				__raw_response: {
					choices: [{ index: 0, delta: { reasoning: "second" } }],
				},
			},
		});
		const merged = chunk1.concat(chunk2);
		expect(extractReasoningFromMessage(merged)).toBe("first second");
	});
});

// ============================================================================
// reasoning_content defensive fallback (Codex pass #1, #2)
// ============================================================================

describe("extractReasoningFromMessage — reasoning_content fallback (gateway shape drift)", () => {
	it("falls back to choices[0].message.reasoning_content when reasoning is absent", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const msg = new AIMessage({
				content: "Answer.",
				additional_kwargs: {
					__raw_response: {
						choices: [
							{
								message: {
									content: "Answer.",
									reasoning_content:
										"openrouter-style reasoning text",
								},
							},
						],
					},
				},
			});
			expect(extractReasoningFromMessage(msg)).toBe(
				"openrouter-style reasoning text",
			);
			expect(warnSpy).toHaveBeenCalledOnce();
			expect(warnSpy.mock.calls[0][0]).toMatch(/reasoning_content/i);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("falls back to choices[0].delta.reasoning_content when reasoning is absent (streaming)", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const msg = new AIMessage({
				content: "Answer.",
				additional_kwargs: {
					__raw_response: {
						choices: [
							{
								index: 0,
								delta: {
									reasoning_content:
										"streaming reasoning_content path",
								},
							},
						],
					},
				},
			});
			expect(extractReasoningFromMessage(msg)).toBe(
				"streaming reasoning_content path",
			);
			expect(warnSpy).toHaveBeenCalledOnce();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("prefers reasoning over reasoning_content when both are present", () => {
		const msg = new AIMessage({
			content: "Answer.",
			additional_kwargs: {
				__raw_response: {
					choices: [
						{
							message: {
								reasoning: "canonical reasoning",
								reasoning_content: "fallback reasoning_content",
							},
						},
					],
				},
			},
		});
		// `reasoning` wins; no warn fires because the fallback branch is skipped.
		expect(extractReasoningFromMessage(msg)).toBe("canonical reasoning");
	});
});

// ============================================================================
// extractReasoningTokens
// ============================================================================

describe("extractReasoningTokens", () => {
	it("reads usage_metadata.output_token_details.reasoning when > 0", () => {
		const msg = new AIMessage({
			content: "answer",
			usage_metadata: {
				input_tokens: 10,
				output_tokens: 50,
				total_tokens: 60,
				output_token_details: { reasoning: 42 },
			},
		});
		expect(extractReasoningTokens(msg)).toBe(42);
	});

	it("returns 0 when usage_metadata is absent", () => {
		const msg = new AIMessage({ content: "answer" });
		expect(extractReasoningTokens(msg)).toBe(0);
	});

	it("returns 0 when reasoning field is missing", () => {
		const msg = new AIMessage({
			content: "answer",
			usage_metadata: {
				input_tokens: 10,
				output_tokens: 50,
				total_tokens: 60,
			},
		});
		expect(extractReasoningTokens(msg)).toBe(0);
	});
});

// ============================================================================
// buildReasoningUpdate (NEW emit.ts surface)
// ============================================================================

describe("buildReasoningUpdate", () => {
	it("produces a populated update for an Anthropic thinking response (happy path)", () => {
		const response = new AIMessage({
			content: [
				{ type: "thinking", thinking: "Analyzing the document..." },
				{ type: "text", text: "Here is my answer." },
			] as never,
		});
		const stateMessages = [new HumanMessage("user asked")];
		const turnStart = Date.now() - 250;
		const update = buildReasoningUpdate({
			response,
			existingByTurn: {},
			stateMessages: stateMessages as never,
			turnStart,
		});

		expect(update.reasoningByTurn).toBeDefined();
		const entry = update.reasoningByTurn?.[1];
		expect(entry?.text).toBe("Analyzing the document...");
		expect(entry?.startedAt).toBe(turnStart);
		expect(entry?.durationMs).toBeGreaterThanOrEqual(0);
		expect(entry?.completedAt).toBeGreaterThanOrEqual(turnStart);
	});

	it("returns empty object when reasoning text is empty (no spread effect)", () => {
		const response = new AIMessage({ content: "no thinking here" });
		const stateMessages = [new HumanMessage("user")];
		const update = buildReasoningUpdate({
			response,
			existingByTurn: undefined,
			stateMessages: stateMessages as never,
			turnStart: Date.now(),
		});
		expect(update).toEqual({});
	});

	it("returns empty object when turnIndex < 1 (defensive — no human messages in state)", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const response = new AIMessage({
				content: [
					{ type: "thinking", thinking: "lost reasoning" },
				] as never,
			});
			const update = buildReasoningUpdate({
				response,
				existingByTurn: {},
				stateMessages: [],
				turnStart: Date.now(),
			});
			expect(update).toEqual({});
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("coalesces with existing in-turn reasoning (text concatenation + preserved startedAt)", () => {
		const response = new AIMessage({
			content: [{ type: "thinking", thinking: "second half." }] as never,
		});
		const stateMessages = [new HumanMessage("user")];
		const update = buildReasoningUpdate({
			response,
			existingByTurn: {
				1: {
					text: "first half. ",
					durationMs: 500,
					startedAt: 1000,
					completedAt: 1500,
				},
			},
			stateMessages: stateMessages as never,
			turnStart: 1700,
		});

		expect(update.reasoningByTurn?.[1].text).toBe(
			"first half. second half.",
		);
		expect(update.reasoningByTurn?.[1].startedAt).toBe(1000);
		expect(update.reasoningByTurn?.[1].completedAt).toBeGreaterThanOrEqual(
			1000,
		);
		expect(update.reasoningByTurn?.[1].durationMs).toBe(
			(update.reasoningByTurn?.[1].completedAt ?? 0) - 1000,
		);
	});

	it("content[] reasoning takes precedence over __raw_response", () => {
		const response = new AIMessage({
			content: [
				{ type: "thinking", thinking: "native thinking text" },
				{ type: "text", text: "Answer." },
			] as never,
			additional_kwargs: {
				__raw_response: {
					choices: [
						{
							message: { reasoning: "should be ignored" },
						},
					],
				},
			},
		});
		const update = buildReasoningUpdate({
			response,
			existingByTurn: {},
			stateMessages: [new HumanMessage("u")] as never,
			turnStart: Date.now(),
		});
		expect(update.reasoningByTurn?.[1].text).toBe("native thinking text");
	});

	it("emits billing-vs-text drift warn when reasoning_tokens > 0 but text is empty", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const response = new AIMessage({
				content: "answer with no reasoning blocks",
				usage_metadata: {
					input_tokens: 10,
					output_tokens: 50,
					total_tokens: 60,
					output_token_details: { reasoning: 1234 },
				},
			});
			const update = buildReasoningUpdate({
				response,
				existingByTurn: {},
				stateMessages: [new HumanMessage("u")] as never,
				turnStart: Date.now(),
				loggerLabel: "[Test]",
			});
			expect(update).toEqual({});
			expect(warnSpy).toHaveBeenCalledOnce();
			expect(warnSpy.mock.calls[0][0]).toMatch(/billing-vs-text drift/i);
		} finally {
			warnSpy.mockRestore();
		}
	});
});

// ============================================================================
// stripRawResponseEnvelope
// ============================================================================

describe("stripRawResponseEnvelope", () => {
	it("deletes __raw_response when present", () => {
		const response = {
			content: "x",
			additional_kwargs: {
				__raw_response: { choices: [{ message: {} }] },
			},
		};
		stripRawResponseEnvelope(response);
		expect(response.additional_kwargs).toEqual({});
	});

	it("is idempotent when __raw_response is absent", () => {
		const response = {
			content: "x",
			additional_kwargs: { other_key: "preserved" },
		};
		stripRawResponseEnvelope(response);
		expect(response.additional_kwargs).toEqual({ other_key: "preserved" });
	});

	it("is a no-op when additional_kwargs itself is absent", () => {
		const response = { content: "x" } as { additional_kwargs?: unknown };
		stripRawResponseEnvelope(response);
		expect(response).toEqual({ content: "x" });
	});

	it("is a no-op for non-object input (null/undefined/primitive)", () => {
		expect(() => stripRawResponseEnvelope(null)).not.toThrow();
		expect(() => stripRawResponseEnvelope(undefined)).not.toThrow();
		expect(() => stripRawResponseEnvelope(42)).not.toThrow();
	});

	it("still deletes __raw_response after hoisting a stop reason out of it", () => {
		const response = {
			content: "x",
			response_metadata: { model_provider: "databricks" },
			additional_kwargs: {
				__raw_response: {
					choices: [{ message: {}, finish_reason: "length" }],
				},
			},
		};
		stripRawResponseEnvelope(response);
		expect(response.additional_kwargs).toEqual({});
	});

	it("a stop reason present only in the raw envelope survives into response_metadata", () => {
		const response = {
			content: "x",
			response_metadata: { model_provider: "databricks", usage: {} },
			additional_kwargs: {
				__raw_response: {
					choices: [{ message: {}, finish_reason: "length" }],
				},
			},
		};
		stripRawResponseEnvelope(response);
		expect(response.response_metadata).toEqual({
			model_provider: "databricks",
			usage: {},
			finish_reason: "length",
		});
	});
});

// ============================================================================
// reasoningByTurnAnnotation (state factory)
// ============================================================================

describe("reasoningByTurnAnnotation", () => {
	// LangGraph 1.x exposes a reducer-shaped Annotation as a
	// BinaryOperatorAggregate channel whose runtime fields are `operator`
	// (the reducer fn) and `initialValueFactory` (the default fn).
	type AggregateChannel = {
		operator: (
			a: Record<number, unknown> | undefined,
			b: Record<number, unknown> | undefined,
		) => Record<number, unknown>;
		initialValueFactory: () => Record<number, unknown>;
	};

	it("defaults to empty record via initialValueFactory", () => {
		const ann = reasoningByTurnAnnotation() as unknown as AggregateChannel;
		expect(ann.initialValueFactory()).toEqual({});
	});

	it("merges incoming entries with existing (no overwrite of unrelated keys)", () => {
		const ann = reasoningByTurnAnnotation() as unknown as AggregateChannel;
		const merged = ann.operator(
			{ 1: { text: "a", durationMs: 1, startedAt: 0, completedAt: 1 } },
			{ 2: { text: "b", durationMs: 2, startedAt: 1, completedAt: 3 } },
		);
		expect(merged).toEqual({
			1: { text: "a", durationMs: 1, startedAt: 0, completedAt: 1 },
			2: { text: "b", durationMs: 2, startedAt: 1, completedAt: 3 },
		});
	});

	it("incoming overwrites existing by SAME turn key (allows mid-turn merge from chat-node side)", () => {
		const ann = reasoningByTurnAnnotation() as unknown as AggregateChannel;
		const merged = ann.operator(
			{ 1: { text: "old", durationMs: 1, startedAt: 0, completedAt: 1 } },
			{ 1: { text: "new", durationMs: 2, startedAt: 0, completedAt: 2 } },
		);
		expect((merged as Record<number, { text: string }>)[1].text).toBe(
			"new",
		);
	});

	it("treats undefined existing/incoming as empty (defensive)", () => {
		const ann = reasoningByTurnAnnotation() as unknown as AggregateChannel;
		expect(ann.operator(undefined, { 1: { text: "x" } })).toEqual({
			1: { text: "x" },
		});
		expect(ann.operator({ 1: { text: "y" } }, undefined)).toEqual({
			1: { text: "y" },
		});
	});
});

// ============================================================================
// Integration: chat-node-style delta computation (migrated)
// ============================================================================

describe("chat-node — reasoning extraction integration", () => {
	it("produces correct state delta for Anthropic thinking response", () => {
		const response = {
			content: [
				{ type: "thinking", thinking: "Analyzing the document..." },
				{ type: "text", text: "Here is my answer." },
			],
		};
		const state = {
			messages: [new HumanMessage("User asked something")],
			reasoningByTurn: {},
		};
		const reasoningText = extractReasoningFromMessage(response);
		const turnIndex = countHumanMessages(state.messages as never);
		expect(reasoningText).toBe("Analyzing the document...");
		expect(turnIndex).toBe(1);
	});

	it("coalesces within a turn (second invocation merges)", () => {
		const state = {
			messages: [new HumanMessage("user")],
			reasoningByTurn: {
				1: {
					text: "first half. ",
					durationMs: 500,
					startedAt: 0,
					completedAt: 500,
				},
			} as Record<
				number,
				{
					text: string;
					durationMs: number;
					startedAt: number;
					completedAt: number;
				}
			>,
		};
		const response = {
			content: [{ type: "thinking", thinking: "second half." }],
		};
		const reasoningText = extractReasoningFromMessage(response);
		const turnIndex = countHumanMessages(state.messages as never);
		const existing = state.reasoningByTurn[turnIndex];
		const merged = (existing?.text ?? "") + reasoningText;
		expect(merged).toBe("first half. second half.");
	});

	it("skips state write when zero human messages (defensive)", () => {
		const state = { messages: [], reasoningByTurn: {} };
		const turnIndex = countHumanMessages(state.messages);
		expect(turnIndex).toBe(0);
	});

	it("response.content normalization preserves visible text for write/patch", () => {
		const response: { content: unknown } = {
			content: [
				{ type: "thinking", thinking: "internal" },
				{
					type: "text",
					text: "Document updated. Want me to also adjust the conclusion?",
				},
			],
		};
		if (Array.isArray(response.content)) {
			response.content = extractTextFromContent(response.content);
		}
		expect(response.content).toBe(
			"Document updated. Want me to also adjust the conclusion?",
		);
	});
});

// =============================================================================
// countHumanMessages — agent-synthesized human turns
// =============================================================================
//
// turnIndex keys reasoningByTurn. A synthetic human turn (tool image output
// delivered as user-role content, the only shape the chat-completions schema
// accepts for image parts) must not advance it, or a single user request is
// split across several reasoning-trace turns in the UI.

describe("countHumanMessages — synthetic image turns", () => {
	const synthetic = () =>
		new HumanMessage({
			content: [
				{ type: "text", text: "Image(s) retrieved by a_tool (c1):" },
			],
			additional_kwargs: { fabricSyntheticToolImage: true },
		});

	it("does not count a synthetic image turn as a user turn", () => {
		expect(
			countHumanMessages([
				new HumanMessage({ content: "look at the screenshot" }),
				synthetic(),
			]),
		).toBe(1);
	});

	it("counts only real user turns when both are present", () => {
		expect(
			countHumanMessages([
				new HumanMessage({ content: "first" }),
				synthetic(),
				new AIMessage({ content: "ok" }),
				new HumanMessage({ content: "second" }),
				synthetic(),
			]),
		).toBe(2);
	});
});
