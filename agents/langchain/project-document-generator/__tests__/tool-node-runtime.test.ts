/**
 * Tests for Fizzy #2427: project-document-generator's server-side tools are
 * built once at module scope and read graph state + the run's AI token off
 * the LangGraph `ToolRuntime` handed to them on invocation, instead of a
 * factory closure captured at tool-node construction time.
 *
 * Three things are exercised, all through the real `ToolNode` (via
 * `toolNode`) against a mocked `fetch`:
 * 1. state/token flow through `ToolRuntime` per invocation, not a stale
 *    closure (first describe block);
 * 2. a tool call the model was never offered (gated off by state) is
 *    rejected as "not found" without touching the network, exactly like
 *    the pre-refactor per-call construction did (second describe block);
 * 3. that gating is applied by selecting from a small memoized set of
 *    `ToolNode`s keyed by the gate flags, not by constructing a `ToolNode`
 *    (or any tool) on every call (second describe block, via a spy on the
 *    `ToolNode` constructor).
 */

import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { agentUsageConfigFromInput } from "@repo/agent-core/services/usage-logging";
import { logger } from "@repo/logs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toolNode } from "../nodes/tool-node";
import type { AgentState } from "../state";

const { toolNodeConstructions } = vi.hoisted(() => ({
	toolNodeConstructions: vi.fn(),
}));

vi.mock("@langchain/langgraph/prebuilt", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@langchain/langgraph/prebuilt")>();
	class SpyToolNode extends actual.ToolNode {
		constructor(...args: ConstructorParameters<typeof actual.ToolNode>) {
			super(...args);
			toolNodeConstructions();
		}
	}
	return { ...actual, ToolNode: SpyToolNode };
});

function createMockState(overrides: Partial<AgentState> = {}): AgentState {
	return {
		messages: [],
		document: "",
		documentType: "architecture",
		projectContext: {
			name: "Test Project",
			techStack: [],
			features: [],
		},
		ragContexts: [],
		systemPrompt: undefined,
		focusAnchor: undefined,
		streamingContent: "",
		retryCount: 0,
		error: undefined,
		copilotkit: { actions: [], context: [] },
		hasTeamsIntegration: false,
		hasSlackIntegration: false,
		hasGitHubIntegration: false,
		hasRepoIntegration: false,
		projectId: "",
		userId: "",
		organizationId: undefined,
		isRegeneration: false,
		documentId: undefined,
		activeSkill: undefined,
		reasoningByTurn: {},
		toolCallsByTurn: {},
		...overrides,
	} as AgentState;
}

function toolCallMessage(
	toolCallId: string,
	name: string,
	args: Record<string, unknown>,
) {
	return new AIMessage({
		content: "",
		tool_calls: [{ id: toolCallId, name, args }],
	});
}

function searchKnowledgeCall(toolCallId: string, query = "auth") {
	return toolCallMessage(toolCallId, "search_project_knowledge", { query });
}

function searchTeamsMessagesCall(toolCallId: string, query = "auth") {
	return toolCallMessage(toolCallId, "search_teams_messages", { query });
}

function mockFetchOk(formatted = "Found: auth notes") {
	return vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		json: async () => ({ formatted, totalCount: 1 }),
	});
}

describe("toolNode — tools read state/token from ToolRuntime, not a closure", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("does not use the logger-only token to authenticate graph tools", async () => {
		const fetchMock = mockFetchOk();
		vi.stubGlobal("fetch", fetchMock);
		await toolNode(
			createMockState({
				messages: [searchKnowledgeCall("call-example")],
				projectId: "project-example",
				userId: "user-example",
			}),
			{
				configurable: agentUsageConfigFromInput({
					ai_token: "usage-token-example",
					ai_model: "model-example",
					ai_provider: "CUSTOM",
				}),
			},
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(
			(fetchMock.mock.calls[0][1].headers as Record<string, string>)[
				"X-AI-Token"
			],
		).toBeUndefined();
	});

	it("reads projectId from this invocation's state and the AI token from this invocation's config", async () => {
		const fetchMock = mockFetchOk();
		vi.stubGlobal("fetch", fetchMock);

		const state = createMockState({
			messages: [searchKnowledgeCall("call_1")],
			projectId: "proj_1",
			userId: "user_1",
		});

		const result = await toolNode(state, {
			configurable: { ai_token: "tok_1" },
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/api/internal/project-context-search");
		expect((init.headers as Record<string, string>)["X-AI-Token"]).toBe(
			"tok_1",
		);
		expect(JSON.parse(init.body as string)).toMatchObject({
			projectId: "proj_1",
		});

		const messages = result.messages ?? [];
		expect(messages).toHaveLength(1);
		expect(messages[0]).toBeInstanceOf(ToolMessage);
		expect((messages[0] as ToolMessage).tool_call_id).toBe("call_1");
	});

	it("does not leak state or the AI token across separate invocations", async () => {
		const fetchMock = mockFetchOk();
		vi.stubGlobal("fetch", fetchMock);

		await toolNode(
			createMockState({
				messages: [searchKnowledgeCall("call_a")],
				projectId: "proj_a",
				userId: "user_a",
			}),
			{ configurable: { ai_token: "tok_a" } },
		);

		await toolNode(
			createMockState({
				messages: [searchKnowledgeCall("call_b")],
				projectId: "proj_b",
				userId: "user_b",
			}),
			{ configurable: { ai_token: "tok_b" } },
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);

		const [, initA] = fetchMock.mock.calls[0] as [string, RequestInit];
		const [, initB] = fetchMock.mock.calls[1] as [string, RequestInit];

		expect((initA.headers as Record<string, string>)["X-AI-Token"]).toBe(
			"tok_a",
		);
		expect(JSON.parse(initA.body as string)).toMatchObject({
			projectId: "proj_a",
		});

		expect((initB.headers as Record<string, string>)["X-AI-Token"]).toBe(
			"tok_b",
		);
		expect(JSON.parse(initB.body as string)).toMatchObject({
			projectId: "proj_b",
		});
	});
});

describe("toolNode — per-call gating without per-call construction", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('rejects a tool call the model was never offered as "not found" without touching the network, but executes it once the gate is on', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ messages: [] }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const disallowedResult = await toolNode(
			createMockState({
				messages: [searchTeamsMessagesCall("call_disallowed")],
				projectId: "proj_1",
				userId: "user_1",
				hasTeamsIntegration: false,
			}),
			{ configurable: { ai_token: "tok_1" } },
		);

		expect(fetchMock).not.toHaveBeenCalled();
		const disallowedMessages = disallowedResult.messages ?? [];
		expect(disallowedMessages).toHaveLength(1);
		expect(disallowedMessages[0]).toBeInstanceOf(ToolMessage);
		expect(
			String((disallowedMessages[0] as ToolMessage).content),
		).toContain("not found");

		await toolNode(
			createMockState({
				messages: [searchTeamsMessagesCall("call_allowed")],
				projectId: "proj_1",
				userId: "user_1",
				hasTeamsIntegration: true,
			}),
			{ configurable: { ai_token: "tok_1" } },
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reuses the ToolNode for a repeated gate combination and only builds a new one when the gates change", async () => {
		const fetchMock = mockFetchOk();
		vi.stubGlobal("fetch", fetchMock);

		const gateState = createMockState({
			messages: [searchKnowledgeCall("call_1")],
			projectId: "proj_1",
			userId: "user_1",
			hasTeamsIntegration: false,
			hasSlackIntegration: false,
			hasRepoIntegration: false,
		});

		await toolNode(gateState, { configurable: { ai_token: "tok_1" } });
		const countAfterFirstCall = toolNodeConstructions.mock.calls.length;

		// Same gate combination again — must be served from the cache.
		await toolNode(gateState, { configurable: { ai_token: "tok_1" } });
		expect(toolNodeConstructions.mock.calls.length).toBe(
			countAfterFirstCall,
		);

		// A different gate combination — must build (and then cache) a new one.
		// hasRepoIntegration is the only flag no earlier test in this file has
		// set, so this key is guaranteed to be a fresh cache miss regardless of
		// what the tests above it already populated the cache with.
		await toolNode(
			createMockState({
				messages: [searchKnowledgeCall("call_2")],
				projectId: "proj_1",
				userId: "user_1",
				hasRepoIntegration: true,
			}),
			{ configurable: { ai_token: "tok_1" } },
		);
		expect(toolNodeConstructions.mock.calls.length).toBe(
			countAfterFirstCall + 1,
		);
	});
});

describe("project source tools", () => {
	afterEach(() => vi.unstubAllGlobals());
	it("sends the search budget", async () => {
		const fetchMock = mockFetchOk();
		vi.stubGlobal("fetch", fetchMock);
		await toolNode(
			createMockState({
				projectId: "example-project",
				userId: "example-user",
				messages: [searchKnowledgeCall("example-call")],
			}),
			{ configurable: { ai_token: "example-token" } },
		);
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
			maxChars: 24000,
		});
	});
	it("reads a source with the token and returns the continuation", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				title: "Example",
				content: "page",
				contentAvailable: true,
				truncated: true,
				nextOffset: 24000,
			}),
		});
		vi.stubGlobal("fetch", fetchMock);
		const result = await toolNode(
			createMockState({
				projectId: "example-project",
				userId: "example-user",
				messages: [
					toolCallMessage("example-call", "read_project_source", {
						sourceId: "example-source",
						offset: 10,
					}),
				],
			}),
			{ configurable: { ai_token: "example-token" } },
		);
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/api/internal/project-source"),
			expect.objectContaining({
				headers: {
					"Content-Type": "application/json",
					"X-AI-Token": "example-token",
				},
			}),
		);
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
			projectId: "example-project",
			sourceId: "example-source",
			offset: 10,
		});
		expect(String(result.messages?.[0].content)).toContain(
			"Example\n\npage\nNext offset: 24000",
		);
	});
	it.each([401, 403, 404])(
		"handles source read status %s",
		async (status) => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({ ok: false, status }),
			);
			const result = await toolNode(
				createMockState({
					projectId: "example-project",
					userId: "example-user",
					messages: [
						toolCallMessage("example-call", "read_project_source", {
							sourceId: "example-source",
						}),
					],
				}),
				{ configurable: { ai_token: "example-token" } },
			);
			expect(String(result.messages?.[0].content)).toMatch(
				/failed|authentication|token/i,
			);
		},
	);
});

// A classified Proposal run logs ids and counts only (Fizzy #2946): the model
// may have written its server-only prompt into a tool's query.
describe("toolNode — logged arguments on a Proposal run", () => {
	const QUERY = "SECRET QUERY TEXT the model wrote";

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	async function loggedSearch(configurable: Record<string, unknown>) {
		vi.stubGlobal("fetch", mockFetchOk());
		const spies = (["info", "warn", "error", "debug"] as const).map(
			(method) =>
				vi.spyOn(logger, method).mockImplementation(() => undefined),
		);
		await toolNode(
			createMockState({
				messages: [searchKnowledgeCall("call_proposal", QUERY)],
				projectId: "project-example",
				userId: "user-example",
			}),
			{ configurable },
		);
		return spies
			.flatMap((spy) =>
				spy.mock.calls.map((args) => JSON.stringify(args)),
			)
			.join("\n");
	}

	it("logs only the length of a query on a Proposal run", async () => {
		const logs = await loggedSearch({
			proposal_mode: "artifact",
			proposal_client_prompt: "A bound prompt for the example proposal.",
		});
		expect(logs).toContain("Executing search_project_knowledge");
		expect(logs).not.toContain("SECRET QUERY TEXT");
		expect(logs).toContain(`[${QUERY.length} chars]`);
	});

	it("still logs the query outside a Proposal", async () => {
		const logs = await loggedSearch({});
		expect(logs).toContain("SECRET QUERY TEXT");
	});
});
