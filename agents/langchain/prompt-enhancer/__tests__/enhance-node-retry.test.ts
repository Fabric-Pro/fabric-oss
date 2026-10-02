/**
 * Retry gate for the enhance node's catch block: permanent provider errors end
 * the run on the first failure, transient ones and malformed generations
 * retry with backoff.
 */

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptEnhancerStateType } from "../state";

const mockInvoke = vi.fn();

vi.mock("../utils", async () => {
	// The real shared retry helpers, so these tests exercise the actual
	// classification; only the backoff sleep is stubbed out.
	const core =
		await vi.importActual<typeof import("@repo/agent-core")>(
			"@repo/agent-core",
		);
	return {
		DEFAULT_RECURSION_LIMIT: 25,
		MAX_RETRIES: 3,
		MAX_JSON_RETRIES: 4,
		getAgentModelAsync: vi.fn().mockResolvedValue({
			bindTools: vi.fn(() => ({
				invoke: (...args: unknown[]) => mockInvoke(...args),
			})),
		}),
		extractProviderConfig: vi.fn().mockReturnValue({ model: "gpt-4o" }),
		isJsonParseError: core.isJsonParseError,
		isRetryableError: core.isRetryableError,
		calculateRetryDelay: core.calculateRetryDelay,
		sleep: vi.fn().mockResolvedValue(undefined),
	};
});

vi.mock("@repo/agent-tools", () => ({
	ENHANCE_PROMPT_TOOL: {
		name: "enhance_prompt_local",
		description: "Enhance a prompt",
		schema: {},
	},
}));

import { enhanceNode } from "../nodes";

function createState(
	overrides: Partial<PromptEnhancerStateType> = {},
): PromptEnhancerStateType {
	return {
		promptId: "prompt-123",
		promptName: "Test Prompt",
		promptDescription: undefined,
		format: "MARKDOWN",
		category: undefined,
		tags: [],
		currentContent: "Original prompt content",
		enhancementType: "general",
		userInstructions: undefined,
		enhancedContent: "",
		explanation: "",
		streamingContent: "",
		focusAnchor: undefined,
		retryCount: 0,
		error: undefined,
		messages: [new HumanMessage("Please improve this prompt")],
		...overrides,
	};
}

async function run(state = createState()) {
	const command = await enhanceNode(state, {});
	const goto = (command as any).goto;
	return {
		goto: Array.isArray(goto) ? goto : [goto],
		update: (command as any).update,
	};
}

describe("enhanceNode retry gate", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
	});

	it.each([
		["401", 401],
		["403", 403],
		["400", 400],
	])(
		"ends the run on an HTTP %s without retrying",
		async (_label, status) => {
			mockInvoke.mockRejectedValueOnce(
				Object.assign(new Error("Request failed"), { status }),
			);

			const { goto, update } = await run();

			expect(goto).toContain("__end__");
			expect(update).toMatchObject({ retryCount: 0 });
			expect(update.error).toBe(
				"Failed to enhance prompt: Request failed",
			);
		},
	);

	it("ends the run on a context-window overflow without retrying", async () => {
		mockInvoke.mockRejectedValueOnce(
			new Error("prompt is too long: 250000 tokens > 200000 maximum"),
		);

		const { goto, update } = await run();

		expect(goto).toContain("__end__");
		expect(update).toMatchObject({ retryCount: 0 });
	});

	it.each([
		[
			"an HTTP 503",
			Object.assign(new Error("Unavailable"), { status: 503 }),
		],
		["an HTTP 429", Object.assign(new Error("Slow down"), { status: 429 })],
		[
			"a connection reset",
			Object.assign(new Error("read failed"), { code: "ECONNRESET" }),
		],
	])("retries %s", async (_label, error) => {
		mockInvoke.mockRejectedValueOnce(error);

		const { goto, update } = await run();

		expect(goto).toContain("enhance");
		expect(update).toMatchObject({
			retryCount: 1,
			error: "Retrying... (attempt 1/3)",
		});
	});

	it("still ends the run once a transient error has used its retries", async () => {
		mockInvoke.mockRejectedValueOnce(
			Object.assign(new Error("Unavailable"), { status: 503 }),
		);

		const { goto, update } = await run(createState({ retryCount: 3 }));

		expect(goto).toContain("__end__");
		expect(update).toMatchObject({ retryCount: 0 });
	});

	it("retries a malformed tool-call JSON generation on the JSON budget", async () => {
		mockInvoke.mockRejectedValueOnce(
			new Error("Failed to parse tool call arguments as JSON"),
		);

		const { goto, update } = await run(createState({ retryCount: 3 }));

		expect(goto).toContain("enhance");
		expect(update).toMatchObject({
			retryCount: 4,
			error: "Retrying... (attempt 4/4)",
		});
	});

	it("retries a tool call that arrived without enhancedContent", async () => {
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [
					{ id: "call_1", name: "enhance_prompt_local", args: {} },
				],
			}),
		);

		const { goto, update } = await run();

		expect(goto).toContain("enhance");
		expect(update).toMatchObject({
			retryCount: 1,
			error: "Retrying... (attempt 1/4)",
		});
	});

	it("surfaces the generation copy once a malformed tool call has used its retries", async () => {
		mockInvoke.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [
					{ id: "call_1", name: "enhance_prompt_local", args: {} },
				],
			}),
		);

		const { goto, update } = await run(createState({ retryCount: 4 }));

		expect(goto).toContain("__end__");
		expect(update.error).toContain("The AI had difficulty processing");
	});
});
