import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAiModelWithSelection } from "../../utils";

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
		isStepCountMock: vi.fn((n: number) => ({ __stopWhen: "stepCount", n })),
	};
});

vi.mock("@repo/ai", () => ({
	streamText: aiStubs.streamTextMock,
	tool: aiStubs.toolMock,
	jsonSchema: aiStubs.jsonSchemaMock,
	isStepCount: aiStubs.isStepCountMock,
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
	getAiModelWithSelection: vi.fn(async () => ({
		model: { __mockModel: true },
		provider: "ANTHROPIC_DIRECT",
		modelString: "claude-sonnet-5",
		canonicalName: "claude-sonnet-5",
	})),
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
 * consumer logic: a `stream` async iterable yielding the given parts,
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
		// AI SDK 7 renamed StreamTextResult.fullStream to `stream`.
		stream: (async function* () {
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

const refusal = new AiUsageLimitExceededError({
	message:
		"AI usage limit exceeded: example-limit (TOKENS, DAILY) — used 10 of 10",
	limitId: "example-limit",
	dimension: "TOKENS",
	window: "DAILY",
	used: 10n,
	max: 10n,
	manageLimitsUrl: "/settings/limits",
});
const expected = {
	message: refusal.message,
	limitId: "example-limit",
	dimension: "TOKENS",
	window: "DAILY",
	used: "10",
	max: "10",
	manageLimitsUrl: "/settings/limits",
};

describe("usage-limit refusals", () => {
	it("returns model-resolution refusal as data", async () => {
		vi.mocked(getAiModelWithSelection).mockRejectedValueOnce(refusal);
		await expect(runAgentIteration(buildInput())).resolves.toMatchObject({
			type: "stream_error",
			message: refusal.message,
			usageLimit: expected,
		});
		expect(aiStubs.streamTextMock).not.toHaveBeenCalled();
	});
	it("stops after one request when the stream refuses usage", async () => {
		aiStubs.streamTextMock.mockImplementation(() =>
			makeStreamResult({
				parts: [{ type: "error", error: refusal }],
			}),
		);
		expect(await runAgentIteration(buildInput())).toMatchObject({
			type: "stream_error",
			usageLimit: expected,
		});
		expect(aiStubs.streamTextMock).toHaveBeenCalledTimes(1);
	});
	it("returns a thrown request refusal as data", async () => {
		aiStubs.streamTextMock.mockImplementation(() => {
			throw refusal;
		});
		expect(await runAgentIteration(buildInput())).toMatchObject({
			type: "stream_error",
			usageLimit: expected,
		});
		expect(aiStubs.streamTextMock).toHaveBeenCalledTimes(1);
	});
	it("still retries a generic stream failure", async () => {
		aiStubs.streamTextMock.mockImplementation(() =>
			makeStreamResult({
				parts: [{ type: "error", error: new Error("connection lost") }],
			}),
		);
		expect(await runAgentIteration(buildInput())).toMatchObject({
			type: "stream_error",
		});
		expect(aiStubs.streamTextMock).toHaveBeenCalledTimes(2);
	});
});
