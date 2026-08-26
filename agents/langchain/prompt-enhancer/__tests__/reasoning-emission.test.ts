import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Drives the enhance-node end-to-end with a stubbed model and asserts that
 * the reasoning capture pipeline produces the expected `reasoningByTurn`
 * slice on Command.update. Mirrors the project-document-generator and
 * backlog-updater reasoning-trace contracts — same helper module from
 * `@repo/agent-core/reasoning-trace` does the extraction.
 *
 * Mocks `getAgentModelAsync` (via `../utils`) and `detectAndCompose` (via
 * `@repo/agent-core`) so the test doesn't need network/DB and can
 * deterministically choose the response shape per case.
 */

const invokeMock = vi.fn();
const bindToolsMock = vi.fn();

vi.mock("../utils", async (importOriginal) => {
	const actual = (await importOriginal<
		typeof import("../utils")
	>()) as Record<string, unknown>;
	return {
		...actual,
		getAgentModelAsync: vi.fn(async () => ({
			invoke: invokeMock,
			bindTools: bindToolsMock.mockImplementation(() => ({
				invoke: invokeMock,
			})),
		})),
	};
});

vi.mock("@repo/agent-core", async (importOriginal) => {
	const actual = (await importOriginal<
		typeof import("@repo/agent-core")
	>()) as Record<string, unknown>;
	return {
		...actual,
		// detectAndCompose returns a no-op so the test doesn't hit Fabric
		// composition. Real implementation may resolve OK but adds latency
		// + non-determinism to a unit test.
		detectAndCompose: vi.fn(async () => ({
			fabricAvailable: false,
			components: {},
			prompt: "Test system prompt",
		})),
		logAgentUsageFromRunnableConfig: vi.fn(async () => {}),
	};
});

vi.mock("@repo/agent-tools", () => ({
	ENHANCE_PROMPT_TOOL: { name: "enhance_prompt_local", description: "stub" },
}));

// Import AFTER vi.mock so the enhance-node sees the stubbed deps.
const { enhanceNode } = await import("../nodes/enhance-node");

const baseState = {
	promptId: "prompt-1",
	promptName: "Test prompt",
	promptDescription: undefined,
	format: "MARKDOWN" as const,
	category: undefined,
	tags: [],
	currentContent: "Existing prompt body.",
	enhancementType: "general" as const,
	userInstructions: undefined,
	enhancedContent: "",
	explanation: "",
	streamingContent: "",
	focusAnchor: undefined,
	retryCount: 0,
	error: undefined,
	reasoningByTurn: {},
};

describe("prompt-enhancer enhanceNode — reasoning emission", () => {
	beforeEach(() => {
		invokeMock.mockReset();
		bindToolsMock.mockClear();
	});

	it("emits reasoningByTurn on tool-success path when response carries thinking blocks", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: [
					{
						type: "thinking",
						thinking: "Reviewing the prompt's clarity…",
					},
					{ type: "text", text: "Here's the enhancement." },
				] as never,
				tool_calls: [
					{
						id: "call_1",
						name: "enhance_prompt_local",
						args: { enhancedContent: "ENHANCED BODY" },
						type: "tool_call" as const,
					},
				],
			}),
		);

		const command = await enhanceNode({
			...baseState,
			messages: [new HumanMessage("make my prompt better")] as never,
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		const reasoningByTurn = (
			update as { reasoningByTurn?: Record<number, { text: string }> }
		).reasoningByTurn;
		expect(reasoningByTurn?.[1].text).toBe(
			"Reviewing the prompt's clarity…",
		);
	});

	it("emits reasoningByTurn on no-tool fallback path when response carries gateway raw_response reasoning", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: "Just a follow-up — no tool call.",
				additional_kwargs: {
					__raw_response: {
						choices: [
							{
								index: 0,
								message: {
									content: "Just a follow-up — no tool call.",
									reasoning:
										"User wants more concise wording.",
								},
							},
						],
					},
				},
			}),
		);

		const command = await enhanceNode({
			...baseState,
			messages: [new HumanMessage("trim this")] as never,
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		const reasoningByTurn = (
			update as { reasoningByTurn?: Record<number, { text: string }> }
		).reasoningByTurn;
		expect(reasoningByTurn?.[1].text).toBe(
			"User wants more concise wording.",
		);
	});

	it("does NOT emit reasoning when response has none", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({ content: "no thinking here" }),
		);

		const command = await enhanceNode({
			...baseState,
			messages: [new HumanMessage("ok")] as never,
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		expect(
			(update as Record<string, unknown>).reasoningByTurn,
		).toBeUndefined();
	});

	it("does NOT invoke model on the post-confirmation acknowledgment branch (no reasoning emitted)", async () => {
		// Construct messages so isAfterConfirmation returns true: an AI
		// message with a confirm_changes tool_call followed by a tool
		// response whose content carries an "accepted" signal.
		const aiWithConfirm = new AIMessage({
			content: "",
			tool_calls: [
				{
					id: "call_1",
					name: "confirm_changes",
					args: {},
					type: "tool_call" as const,
				},
			],
		});
		const toolResponse = {
			type: "tool",
			content: "accepted",
			tool_call_id: "call_1",
			name: "confirm_changes",
		};

		const command = await enhanceNode({
			...baseState,
			messages: [
				new HumanMessage("accept"),
				aiWithConfirm,
				toolResponse,
			] as never,
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		expect(invokeMock).not.toHaveBeenCalled();
		expect(
			(update as Record<string, unknown>).reasoningByTurn,
		).toBeUndefined();
	});
});
