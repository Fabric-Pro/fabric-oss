/**
 * A cancelled Direct chat activity stops its model call and ends as
 * cancelled.
 *
 * Stop and a closed page cancel the workflow, and the workflow cancels this
 * activity. Temporal hands the activity that cancel as its context's
 * `cancellationSignal`. Before this, nothing in the activity read it: the
 * signal given to `streamText` came from an agent-tool runtime Direct chat
 * never installs, so the provider call ran to completion, and an abort that
 * did reach the stream was returned as a finished answer or a failed turn
 * (which the workflow reruns without tools) rather than as a cancellation.
 *
 * The other boundaries are mocked as in `runtime-tools-wiring.test.ts`.
 */

import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { CancelledFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectChatWorkflowInput } from "../../../types";

type ToolCallOptions = { abortSignal?: AbortSignal; toolCallId: string };
type CallableTool = {
	execute: (args: unknown, options: ToolCallOptions) => Promise<unknown>;
};
type StreamRequest = {
	abortSignal?: AbortSignal;
	tools?: Record<string, CallableTool>;
};
type StreamResult = {
	stream: AsyncIterable<unknown>;
	usage: Promise<unknown>;
	steps: Promise<unknown[]>;
};

const state = vi.hoisted(() => ({
	captured: undefined as StreamRequest | undefined,
	recordAggregateUsage: vi.fn(),
	provider: "VERCEL_GATEWAY",
	modelString: "openai/gpt-6-luna",
	enhance: undefined as unknown as ReturnType<typeof vi.fn>,
	activity: new AbortController(),
	respond: (_request: StreamRequest): StreamResult => {
		throw new Error("set state.respond in the test");
	},
	// What the MCP server's tool does when it is actually called.
	mcpExecute: vi.fn(async () => ({ written: true })),
	readOnlyGuard: vi.fn(async (): Promise<unknown> => null),
	listWorkflows: vi.fn(async () => []),
}));

vi.mock("@repo/agent-core/backend", () => ({
	closeMcpClientSafe: vi.fn(),
	getMcpClient: vi.fn(async () => ({
		client: {
			tools: async () => ({
				write_record: {
					description: "Write a record",
					inputSchema: {},
					execute: state.mcpExecute,
				},
			}),
		},
	})),
}));
vi.mock("@repo/ai", async () => {
	const usageLogging = await vi.importActual<
		typeof import("@repo/ai/lib/usage-logging-middleware")
	>("@repo/ai/lib/usage-logging-middleware");
	state.enhance = vi.fn(async () => ({ fabricUsed: false }));
	return {
		convertToModelMessages: async (
			messages: Array<{ role: string; parts: Array<{ text: string }> }>,
		) =>
			messages.map((m) => ({
				role: m.role,
				content: m.parts.map((p) => p.text).join(""),
			})),
		enhancePromptWithFabric: state.enhance,
		getAIModelWithMetadata: async () => ({
			model: { id: "test-model" },
			metadata: {
				provider: state.provider,
				modelString: state.modelString,
				canonicalName: state.modelString,
				contextWindow: 200_000,
				selectionSource: "test",
			},
			trackUsage: vi.fn(),
			recordAggregateUsage: state.recordAggregateUsage,
		}),
		getCurrentDateContext: () => "Today is October 2, 2026.",
		isStepCount: (n: number) => n,
		selectAggregateUsageForLogging:
			usageLogging.selectAggregateUsageForLogging,
		streamText: (request: { abortSignal?: AbortSignal }) => {
			state.captured = request;
			return state.respond(request);
		},
		tool: (definition: unknown) => definition,
	};
});
vi.mock("@repo/ai/capabilities", () => ({
	DEFAULT_MODEL_CAPABILITIES: {},
	getModelCapabilities: () => ({}),
}));
vi.mock("@repo/ai/limits", () => ({ classifyLimitError: () => ({}) }));
vi.mock("@repo/ai/skills", () => ({
	buildSkillsSystemBlock: () => "",
	createSkillTools: () => ({}),
	listAvailableSkills: async () => [],
}));
vi.mock("@repo/database", () => ({
	ensureSensitiveOperationAuthority: vi.fn(async () => ({
		authorized: true,
	})),
	getDefaultRagSettings: () => ({ similarityThreshold: 0.5 }),
	getProjectRagSettings: vi.fn(),
	getWorkflowById: vi.fn(),
	listWorkflows: state.listWorkflows,
	loadProjectDatabricksKnowledgeBinding: async () => null,
}));
vi.mock("../../../lib/company-context-chat-access", () => ({
	resolveCompanyContextChatAccess: async () => null,
}));
vi.mock("../../../lib/company-context-search", () => ({
	searchCompanyContext: vi.fn(),
}));
vi.mock("../../shared/project-context-block", () => ({
	buildProjectContextBlock: async () => null,
}));
vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
	Context: {
		current: () => ({ cancellationSignal: state.activity.signal }),
	},
}));
vi.mock("../built-in-tools", () => ({ createBuiltInTools: async () => ({}) }));
vi.mock("../advisor-tools", () => ({
	createAdvisorTools: () => ({ list_recent_sessions: {} }),
}));
vi.mock("../../orchestrator/utils", () => ({ jsonSchemaToZod: vi.fn() }));
vi.mock("../../orchestrator/execution/authority-gate", () => ({
	classifyToolAccessLevel: vi.fn(),
	resolveProviderKey: vi.fn(),
}));

vi.mock("../../shared/confirmed-workflow", () => ({
	executeApprovedWorkflow: vi.fn(),
}));
vi.mock("../../shared/databricks-knowledge", () => ({
	buildDatabricksKnowledgeToolDefinition: vi.fn(),
	databricksKnowledgeToolName: vi.fn(),
	executeDatabricksKnowledgeSearchSafe: vi.fn(),
	loadAgentDatabricksBindings: async () => [],
	mergeDatabricksBindings: () => [],
}));
vi.mock("../../shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: state.readOnlyGuard,
}));

import { executeDirectChatActivity } from "../ai-execution";

const USAGE = {
	inputTokens: 900,
	outputTokens: 40,
	totalTokens: 940,
	inputTokenDetails: {},
	outputTokenDetails: {},
};

const NULL_USAGE = {
	inputTokens: undefined,
	inputTokenDetails: {
		noCacheTokens: undefined,
		cacheReadTokens: undefined,
		cacheWriteTokens: undefined,
	},
	outputTokens: undefined,
	outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
	totalTokens: undefined,
	raw: undefined,
};

const MCP_SERVER = {
	configId: "mcp-1",
	serverName: "records",
	configName: "Records",
	tools: [{ name: "write_record" }],
};

function runTurn(withMcp = false) {
	return executeDirectChatActivity(
		{
			executionId: "exec-1",
			message: "Summarise the roadmap",
			history: [],
			userId: "user-1",
			organizationId: "org-1",
			reasoningMode: "balanced",
			// Attached servers load whatever the message says.
			...(withMcp ? { enabledMcpConfigIds: [MCP_SERVER.configId] } : {}),
		} as DirectChatWorkflowInput,
		withMcp ? [MCP_SERVER] : [],
		"",
		"",
	);
}

function toolNamed(
	request: StreamRequest,
	match: (name: string) => boolean,
): CallableTool {
	const name = Object.keys(request.tools ?? {}).find(match);
	if (!name || !request.tools) {
		throw new Error("tool not offered to the model");
	}
	return request.tools[name];
}

beforeEach(() => {
	state.captured = undefined;
	state.recordAggregateUsage.mockReset();
	state.activity = new AbortController();
	state.mcpExecute.mockClear();
	state.listWorkflows.mockClear();
	state.readOnlyGuard.mockReset();
	state.readOnlyGuard.mockImplementation(async () => null);
});

describe("direct chat: a cancelled activity", () => {
	it("records the streaming step's measured input when cancelled after message_start", async () => {
		state.respond = () => ({
			stream: (async function* () {
				yield { type: "start-step" };
				yield {
					type: "custom",
					kind: "anthropic.message_start",
					providerMetadata: {
						anthropic: {
							usage: {
								input_tokens: 100,
								cache_read_input_tokens: 70,
								cache_creation_input_tokens: 20,
								output_tokens: 2,
							},
						},
					},
				};
				yield { type: "text-delta", text: "The first part" };
				state.activity.abort(new CancelledFailure("CANCELLED"));
				yield { type: "abort" };
			})(),
			usage: Promise.resolve(undefined),
			steps: Promise.resolve([]),
		});

		await expect(runTurn()).rejects.toBeInstanceOf(CancelledFailure);
		expect(state.recordAggregateUsage).toHaveBeenCalledTimes(1);
		expect(state.recordAggregateUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				usage: expect.objectContaining({
					inputTokens: 190,
					outputTokens: 2,
					totalTokens: 192,
				}),
				success: false,
				errorDetails: { usageReportedAt: "stream_start" },
			}),
		);
	});

	it("aborts the model call and ends as cancelled, not with the partial answer", async () => {
		const activity = state.activity;
		// A provider that keeps answering unless the request's own signal
		// stops it, as the AI SDK does: on abort it ends the stream with an
		// `abort` part instead of throwing.
		state.respond = (request) => ({
			stream: (async function* () {
				yield { type: "text-delta", text: "The first part" };
				activity.abort(new CancelledFailure("CANCELLED"));
				await new Promise((resolve) => setTimeout(resolve, 0));
				if (request.abortSignal?.aborted) {
					yield { type: "abort" };
					return;
				}
				yield { type: "text-delta", text: " and the rest." };
				yield { type: "finish", finishReason: "stop" };
			})(),
			usage: Promise.resolve(USAGE),
			steps: Promise.resolve([]),
		});

		const turn = runTurn();

		await expect(turn).rejects.toBeInstanceOf(CancelledFailure);
		expect(state.captured?.abortSignal?.aborted).toBe(true);
	});

	it("reports an abort error thrown after the cancel as the cancellation, not a failed turn", async () => {
		const activity = state.activity;
		state.respond = () => ({
			stream: (async function* () {
				yield { type: "text-delta", text: "The first part" };
				activity.abort(new CancelledFailure("CANCELLED"));
				throw new DOMException(
					"The operation was aborted.",
					"AbortError",
				);
			})(),
			usage: Promise.resolve(USAGE),
			steps: Promise.resolve([]),
		});

		await expect(runTurn()).rejects.toBeInstanceOf(CancelledFailure);
	});

	it("reports cancellation when a limit refusal is thrown after Stop", async () => {
		state.respond = () => {
			state.activity.abort(new CancelledFailure("CANCELLED"));
			throw new AiUsageLimitExceededError({
				message:
					"AI usage limit exceeded: example-limit (TOKENS, MONTHLY)",
				limitId: "example-limit",
				dimension: "TOKENS",
				window: "MONTHLY",
				used: 100n,
				max: 100n,
				manageLimitsUrl: "https://example.com/limits",
			});
		};
		await expect(runTurn()).rejects.toBeInstanceOf(CancelledFailure);
		expect(state.recordAggregateUsage).not.toHaveBeenCalled();
	});

	it("control: a turn nobody cancels answers as before, with the live signal attached", async () => {
		state.respond = () => ({
			stream: (async function* () {
				yield { type: "text-delta", text: "All of it." };
				yield { type: "finish", finishReason: "stop" };
			})(),
			usage: Promise.resolve(USAGE),
			steps: Promise.resolve([]),
		});

		const result = await runTurn();

		expect(result).toMatchObject({
			success: true,
			responseText: "All of it.",
		});
		expect(state.captured?.abortSignal).toBeDefined();
		expect(state.captured?.abortSignal?.aborted).toBe(false);
	});
});

describe("direct chat: stream-error usage", () => {
	it.each([
		{ reported: NULL_USAGE, inputTokens: 190, marked: true },
		{ reported: USAGE, inputTokens: 900, marked: false },
	])(
		"marks stream-start usage only when selected: %j",
		async ({ reported, inputTokens, marked }) => {
			state.respond = () => ({
				stream: (async function* () {
					yield { type: "start-step" };
					yield {
						type: "custom",
						kind: "anthropic.message_start",
						providerMetadata: {
							anthropic: {
								usage: { input_tokens: 190, output_tokens: 2 },
							},
						},
					};
					yield { type: "text-delta", text: "The first part" };
					yield {
						type: "error",
						error: new Error("Provider stream failed"),
					};
					yield {
						type: "finish-step",
						usage: reported,
						finishReason: "error",
					};
					yield {
						type: "finish",
						totalUsage: reported,
						finishReason: "error",
					};
				})(),
				usage: Promise.resolve(reported),
				steps: Promise.resolve([
					{
						providerMetadata: {
							gateway: { generationId: "example-generation" },
						},
					},
				]),
			});

			await expect(runTurn()).resolves.toMatchObject({
				partialError: "Provider stream failed",
			});
			expect(state.recordAggregateUsage).toHaveBeenCalledTimes(1);
			const row = state.recordAggregateUsage.mock.calls[0][0];
			expect(row).toMatchObject({
				success: false,
				usage: { inputTokens },
			});
			expect(row.errorDetails).toEqual(
				marked ? { usageReportedAt: "stream_start" } : undefined,
			);
		},
	);

	it("records no estimate when an errored stream has text but no measured usage", async () => {
		state.respond = () => ({
			stream: (async function* () {
				yield { type: "start-step" };
				yield { type: "text-delta", text: "The first part" };
				yield {
					type: "error",
					error: new Error("Provider stream failed"),
				};
				yield {
					type: "finish-step",
					usage: NULL_USAGE,
					finishReason: "error",
				};
				yield {
					type: "finish",
					totalUsage: NULL_USAGE,
					finishReason: "error",
				};
			})(),
			usage: Promise.resolve(NULL_USAGE),
			steps: Promise.resolve([]),
		});
		await expect(runTurn()).resolves.toMatchObject({
			partialError: "Provider stream failed",
		});
		expect(state.recordAggregateUsage).toHaveBeenCalledTimes(1);
		expect(state.recordAggregateUsage.mock.calls[0][0]).toMatchObject({
			success: false,
		});
		expect(state.recordAggregateUsage.mock.calls[0][0].usage).toMatchObject(
			{
				inputTokens: undefined,
				outputTokens: undefined,
				totalTokens: undefined,
			},
		);
		expect(
			state.recordAggregateUsage.mock.calls[0][0].errorDetails,
		).toBeUndefined();
	});
});

describe("direct chat: tools in a cancelled turn", () => {
	it("does not call the MCP tool when the turn is cancelled while its guard is awaited", async () => {
		const activity = state.activity;
		let releaseGuard: (value: unknown) => void = () => undefined;
		state.readOnlyGuard.mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseGuard = resolve;
				}),
		);
		state.respond = (request) => ({
			stream: (async function* () {
				const call = toolNamed(request, (name) =>
					name.includes("write_record"),
				)
					.execute(
						{ id: "record-1" },
						{
							abortSignal: request.abortSignal,
							toolCallId: "call-1",
						},
					)
					.catch((error: unknown) => error);
				// Stop lands while the wrapper awaits its read-only guard.
				await new Promise((resolve) => setTimeout(resolve, 0));
				activity.abort(new CancelledFailure("CANCELLED"));
				releaseGuard(null);
				await call;
				yield { type: "abort" };
			})(),
			usage: Promise.resolve(USAGE),
			steps: Promise.resolve([]),
		});

		await expect(runTurn(true)).rejects.toBeInstanceOf(CancelledFailure);
		expect(state.readOnlyGuard).toHaveBeenCalled();
		expect(state.mcpExecute).not.toHaveBeenCalled();
	});

	it("passes the call's abort signal on to the MCP tool it does call", async () => {
		state.respond = (request) => ({
			stream: (async function* () {
				await toolNamed(request, (name) =>
					name.includes("write_record"),
				).execute(
					{ id: "record-1" },
					{ abortSignal: request.abortSignal, toolCallId: "call-1" },
				);
				yield { type: "text-delta", text: "Written." };
				yield { type: "finish", finishReason: "stop" };
			})(),
			usage: Promise.resolve(USAGE),
			steps: Promise.resolve([]),
		});

		await expect(runTurn(true)).resolves.toMatchObject({ success: true });
		expect(state.mcpExecute).toHaveBeenCalledWith(
			{ id: "record-1" },
			expect.objectContaining({
				abortSignal: state.captured?.abortSignal,
			}),
		);
	});

	it("does not run a tool the SDK calls after the turn was cancelled", async () => {
		const activity = state.activity;
		state.respond = (request) => ({
			stream: (async function* () {
				activity.abort(new CancelledFailure("CANCELLED"));
				// A call with no per-call signal: only the turn's own
				// cancellation can stop it.
				await toolNamed(request, (name) => name === "list_workflows")
					.execute({}, { toolCallId: "call-2" })
					.catch(() => undefined);
				yield { type: "abort" };
			})(),
			usage: Promise.resolve(USAGE),
			steps: Promise.resolve([]),
		});

		await expect(runTurn()).rejects.toBeInstanceOf(CancelledFailure);
		expect(state.listWorkflows).not.toHaveBeenCalled();
	});

	it("runs the turn under a dispatch guard that refuses writes once it is cancelled", async () => {
		const activity = state.activity;
		const { getDispatchGuard, throwIfDispatchStopped } = await import(
			"@repo/utils/dispatch-guard"
		);
		const seen: { guarded?: boolean; refused?: unknown } = {};
		state.respond = () => ({
			stream: (async function* () {
				seen.guarded = getDispatchGuard() !== undefined;
				activity.abort(new CancelledFailure("CANCELLED"));
				try {
					throwIfDispatchStopped();
				} catch (error) {
					seen.refused = error;
				}
				yield { type: "abort" };
			})(),
			usage: Promise.resolve(USAGE),
			steps: Promise.resolve([]),
		});

		await expect(runTurn()).rejects.toBeInstanceOf(CancelledFailure);
		expect(seen.guarded).toBe(true);
		expect(seen.refused).toBeInstanceOf(CancelledFailure);
	});
});
