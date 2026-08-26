/**
 * runAgentIteration suppression — activity unit tests.
 *
 * Defense-in-depth at the activity boundary. The workflow phase
 * (`applyDefaultMcpEagerRouting`) already deletes suppressed names from
 * `availableTools`, but the activity ALSO drops them when assembling its
 * `aiSdkTools` map and refuses to force them via `toolChoice`. This file
 * locks both behaviors:
 *
 *   1. `omits suppressed tool names from aiSdkTools`
 *   2. `does not force a suppressed forcedFrameToolName (toolChoice = "auto")`
 *
 * The test inspects the `streamText` call args directly — that's the single
 * boundary where `aiSdkTools` and `toolChoice` are observable in production.
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
 * consumer logic: an empty `fullStream` async iterable plus resolved
 * `usage`/`finishReason` promises. The activity ends with a
 * "no tool calls" final-response branch, which is fine — we only need the
 * call to complete so the args we passed are captured.
 */
function makeStreamResult() {
	return {
		fullStream: (async function* () {
			// Empty stream — no text deltas, no tool calls, no errors.
		})(),
		usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
		finishReason: Promise.resolve("stop"),
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
		availableTools: {},
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
	aiStubs.streamTextMock.mockImplementation(() => makeStreamResult());
});

afterEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("runAgentIteration — suppressedToolNames", () => {
	it("omits suppressed tool names from aiSdkTools", async () => {
		await runAgentIteration(
			buildInput({
				availableTools: {
					fabric_create_frame: {
						description: "Create a Fabric Frame.",
						inputSchema: { type: "object", properties: {} },
					},
					create_view: {
						description: "Create an Excalidraw view.",
						inputSchema: { type: "object", properties: {} },
					},
				},
				suppressedToolNames: ["fabric_create_frame"],
			}),
		);

		expect(aiStubs.streamTextMock).toHaveBeenCalledTimes(1);
		const callArg = aiStubs.streamTextMock.mock.calls[0][0] as {
			tools?: Record<string, unknown>;
		};

		// The suppressed tool MUST NOT appear in the tools map handed to
		// the LLM, even though it WAS present in `availableTools`.
		expect(callArg.tools).toBeDefined();
		expect(callArg.tools?.fabric_create_frame).toBeUndefined();
		// The non-suppressed tool stays — suppression is a denylist, not
		// a whole-map clear.
		expect(callArg.tools?.create_view).toBeDefined();
	});

	it('does not force a suppressed forcedFrameToolName (sets toolChoice to "auto")', async () => {
		// Trigger the activity's prompt-heuristic that would normally force
		// `fabric_create_frame` via `toolChoice`. Phrase chosen because
		// `detectRequestedFrameOutput` matches "interactive dashboard".
		// (Source: run-agent-iteration.ts `framePatterns` list.)
		const triggerMessage =
			"Build me an interactive dashboard for the team metrics.";

		await runAgentIteration(
			buildInput({
				conversationHistory: [
					{
						role: "user",
						content: triggerMessage,
						timestamp: "2026-05-04T00:00:00.000Z",
					},
				],
				availableTools: {
					// `fabric_create_frame` is provided AND suppressed — the
					// activity must drop it from `aiSdkTools` (case 1) AND
					// fall back to `toolChoice: "auto"` instead of forcing
					// the suppressed name (this case).
					fabric_create_frame: {
						description: "Create a Fabric Frame.",
						inputSchema: { type: "object", properties: {} },
					},
					create_view: {
						description: "Create an Excalidraw view.",
						inputSchema: { type: "object", properties: {} },
					},
				},
				suppressedToolNames: ["fabric_create_frame"],
			}),
		);

		expect(aiStubs.streamTextMock).toHaveBeenCalledTimes(1);
		const callArg = aiStubs.streamTextMock.mock.calls[0][0] as {
			tools?: Record<string, unknown>;
			toolChoice?: unknown;
		};

		// The forced-tool path must back off to "auto" — forcing a
		// suppressed (and therefore absent) name would throw a no-tool
		// error from the AI SDK.
		expect(callArg.toolChoice).toBe("auto");
		// And the suppressed name must still be absent from the map.
		expect(callArg.tools?.fabric_create_frame).toBeUndefined();
	});
});
