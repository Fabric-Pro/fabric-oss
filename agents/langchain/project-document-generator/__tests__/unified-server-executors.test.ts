import {
	AIMessage,
	AIMessageChunk,
	ToolMessage,
} from "@langchain/core/messages";
/**
 * The unified server's two executors (the LangGraph Platform stream and the
 * synchronous invoke), driven with a mocked graph: which frontend actions
 * reach the graph, what a guest's failed run says, and which runs stream a
 * live preview of a whole-document write.
 */

import {
	askClarifyingQuestionAction,
	frontendActionJsonDefinition,
	githubGetFileContentsAction,
	gitlabListMergeRequestsAction,
} from "@repo/utils/editor-frontend-actions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROPOSAL_GUEST_ERROR_REPLY } from "../nodes/proposal-client-mode";

const { graph, server } = vi.hoisted(() => ({
	graph: { invoke: vi.fn(), stream: vi.fn() },
	server: { args: [] as unknown[] },
}));

vi.mock("@repo/agent-core/unified-server", () => ({
	createUnifiedServer: (...args: unknown[]) => {
		server.args = args;
		return { app: {}, start: vi.fn() };
	},
	getUserFacingError: (error: unknown) => error,
}));

vi.mock("../agent.js", () => ({ projectDocumentGeneratorGraph: graph }));

await import("../unified-server");

type Executor = (
	input: Record<string, unknown>,
	config?: { configurable?: Record<string, unknown> },
) => Promise<Record<string, unknown>>;
type StreamExecutor = (
	input: Record<string, unknown>,
	config?: { configurable?: Record<string, unknown> },
) => AsyncGenerator<Record<string, unknown>>;

const invoke = () => server.args[1] as Executor;
const platformStream = () => server.args[4] as StreamExecutor;

/** The editor's frontend actions as CopilotKit sends them. */
const EDITOR_ACTIONS = [
	"confirm_changes",
	"regenerate_document",
	"ask_clarifying_question",
	"select_meetings",
	"fetchMeetingNotes",
	"suggest_diagram",
	"create_view",
	"github_get_file_contents",
	"github_list_pull_requests",
	"gitlab_list_merge_requests",
].map((name) => ({
	name,
	description: `The browser's ${name}.`,
	parameters: { type: "object", properties: {} },
}));

/** MCP server tools, each by one of the marks MCP tools carry. */
const MCP_TOOLS = [
	{ name: "example__list_issues", description: "Gateway-namespaced." },
	{
		name: "firecrawl_search",
		description: "CopilotKit MCP.",
		_isMCPTool: true,
	},
	{ name: "example-mcp_get_card", description: "Server-id prefixed." },
];

const OFFERED = [...EDITOR_ACTIONS, ...MCP_TOOLS];

function runInput(extra: Record<string, unknown> = {}) {
	return {
		messages: [{ role: "user", content: "Tighten the scope." }],
		tools: OFFERED,
		...extra,
	};
}

function artifactConfig(viewer: "member" | "guest", extra = {}) {
	return {
		configurable: {
			proposal_mode: "artifact",
			proposal_client_prompt:
				"You revise a client proposal for Example Org.",
			proposal_viewer: viewer,
			...extra,
		},
	};
}

function streamOf(chunks: unknown[]) {
	return (async function* () {
		for (const chunk of chunks) {
			yield chunk;
		}
	})();
}

async function drain(
	generator: AsyncGenerator<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
	const events: Array<Record<string, unknown>> = [];
	for await (const event of generator) {
		events.push(event);
	}
	return events;
}

function boundActionNames(call: unknown[]): string[] {
	const input = call[0] as {
		copilotkit?: { actions: Array<{ name: string }> };
	};
	return (input.copilotkit?.actions ?? []).map((action) => action.name);
}

beforeEach(() => {
	graph.invoke.mockReset().mockResolvedValue({ document: "", messages: [] });
	graph.stream.mockReset().mockImplementation(async () => streamOf([]));
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("frontend actions reaching the graph", () => {
	const EDITOR_NAMES = EDITOR_ACTIONS.map((action) => action.name);

	it("binds every editor action, underscores and all, outside a Proposal (stream)", async () => {
		await drain(platformStream()(runInput(), { configurable: {} }));

		expect(boundActionNames(graph.stream.mock.calls[0])).toEqual(
			EDITOR_NAMES,
		);
	});

	it("binds every editor action outside a Proposal (invoke), from the SDK state too", async () => {
		await invoke()(
			runInput({
				tools: undefined,
				state: { copilotkit: { actions: OFFERED } },
			}),
		);

		expect(boundActionNames(graph.invoke.mock.calls[0])).toEqual(
			EDITOR_NAMES,
		);
	});

	it("binds the allow-listed editor actions as the shared definitions on an artifact Proposal", async () => {
		const policy = "Clarifying-question policy: THOROUGH. Ask freely.";
		await drain(
			platformStream()(
				runInput(),
				artifactConfig("member", {
					proposal_clarifying_policy: policy,
				}),
			),
		);

		const input = graph.stream.mock.calls[0][0] as {
			copilotkit: { actions: unknown[] };
		};
		expect(boundActionNames(graph.stream.mock.calls[0])).toEqual([
			"confirm_changes",
			"regenerate_document",
			"ask_clarifying_question",
			"select_meetings",
			"fetchMeetingNotes",
			"create_view",
			"github_get_file_contents",
			"github_list_pull_requests",
			"gitlab_list_merge_requests",
		]);
		expect(input.copilotkit.actions).toContainEqual(
			frontendActionJsonDefinition(askClarifyingQuestionAction(policy)),
		);
		expect(input.copilotkit.actions).toContainEqual(
			frontendActionJsonDefinition(githubGetFileContentsAction(null)),
		);
		expect(input.copilotkit.actions).toContainEqual(
			frontendActionJsonDefinition(gitlabListMergeRequestsAction(null)),
		);
	});

	it("drops MCP server tools in every mode", async () => {
		await drain(platformStream()(runInput(), { configurable: {} }));
		await drain(platformStream()(runInput(), artifactConfig("member")));

		for (const call of graph.stream.mock.calls) {
			for (const tool of MCP_TOOLS) {
				expect(boundActionNames(call)).not.toContain(tool.name);
			}
		}
	});
});

describe("the graph's config on the synchronous path", () => {
	function graphConfigurable(): Record<string, unknown> {
		const options = graph.invoke.mock.calls[0][1] as {
			configurable?: Record<string, unknown>;
		};
		return options.configurable ?? {};
	}

	it("carries the route's proposal keys, so the chat node keeps the Proposal's mode", async () => {
		await invoke()(
			runInput(),
			artifactConfig("guest", {
				proposal_settled_block: "Scope: agreed.",
			}),
		);

		expect(graphConfigurable()).toMatchObject({
			proposal_mode: "artifact",
			proposal_client_prompt:
				"You revise a client proposal for Example Org.",
			proposal_viewer: "guest",
			proposal_settled_block: "Scope: agreed.",
		});
	});

	it("adds no proposal key outside a Proposal", async () => {
		await invoke()(runInput(), {
			configurable: { tenant_user_id: "user-1" },
		});

		expect(
			Object.keys(graphConfigurable()).filter((key) =>
				key.startsWith("proposal_"),
			),
		).toEqual([]);
	});
});

describe("a guest's failed run on the synchronous path", () => {
	const PROVIDER_ERROR =
		"400 from provider: request echoed 'You revise a client proposal for Example Org.'";

	it("throws only the generic error for a guest", async () => {
		graph.invoke.mockRejectedValueOnce(new Error(PROVIDER_ERROR));

		await expect(
			invoke()(runInput(), artifactConfig("guest")),
		).rejects.toThrow(new Error(PROPOSAL_GUEST_ERROR_REPLY));
		expect(
			JSON.stringify(vi.mocked(console.error).mock.calls),
		).not.toContain("Example Org");
	});

	it("returns the generic reply for a guest's graph error", async () => {
		graph.invoke.mockResolvedValueOnce({
			document: "",
			error: PROVIDER_ERROR,
			messages: [{ role: "assistant", content: PROVIDER_ERROR }],
		});

		const output = await invoke()(runInput(), artifactConfig("guest"));

		expect(output.error).toBe(PROPOSAL_GUEST_ERROR_REPLY);
		expect(output.textResponse).toBe(PROPOSAL_GUEST_ERROR_REPLY);
		expect(JSON.stringify(output)).not.toContain("Example Org");
	});

	it("passes a member's error through as it is", async () => {
		graph.invoke.mockRejectedValueOnce(new Error(PROVIDER_ERROR));

		await expect(
			invoke()(runInput(), artifactConfig("member")),
		).rejects.toThrow(PROVIDER_ERROR);
	});

	it("passes an error outside a Proposal through as it is", async () => {
		graph.invoke.mockResolvedValueOnce({ document: "", error: "Quota" });

		const output = await invoke()(runInput());

		expect(output.error).toBe("Quota");
	});
});

describe("error logs of a Proposal run", () => {
	const PROVIDER_TEXT =
		"Provider rejected the request: 'You revise a client proposal for Example Org.'";

	function providerError() {
		return Object.assign(new Error(PROVIDER_TEXT), {
			status: 400,
			code: "invalid_request_error",
		});
	}

	beforeEach(() => {
		vi.mocked(console.error).mockClear();
	});

	it("has the server redact the error logs of a classified Proposal run only", () => {
		const { redactErrorLogs } = server.args[0] as {
			redactErrorLogs?: (
				configurable?: Record<string, unknown>,
			) => boolean;
		};

		expect(redactErrorLogs?.(artifactConfig("member").configurable)).toBe(
			true,
		);
		expect(redactErrorLogs?.({ proposal_mode: "unbound" })).toBe(true);
		expect(redactErrorLogs?.({ proposal_mode: "none" })).toBe(false);
		expect(redactErrorLogs?.(undefined)).toBe(false);
	});

	it("logs a member's failure by class, code and status, and throws it as it is", async () => {
		graph.invoke.mockRejectedValueOnce(providerError());

		await expect(
			invoke()(runInput(), artifactConfig("member")),
		).rejects.toThrow(PROVIDER_TEXT);

		const logs = JSON.stringify(vi.mocked(console.error).mock.calls);
		expect(logs).not.toContain("Example Org");
		expect(logs).toContain('"errorType":"Error"');
		expect(logs).toContain("invalid_request_error");
		expect(logs).toContain('"httpStatus":400');
	});

	it("logs nothing of its own for a failure outside a Proposal", async () => {
		graph.invoke.mockRejectedValueOnce(providerError());

		await expect(invoke()(runInput())).rejects.toThrow(PROVIDER_TEXT);

		expect(vi.mocked(console.error)).not.toHaveBeenCalled();
	});
});

describe("a guest's reply on the synchronous path", () => {
	const BOUND_PROMPT = "You revise a client proposal for Example Org.";

	/** An earlier string reply, then a reply in thinking and text blocks. */
	function blockReplyResult(extra: Record<string, unknown> = {}) {
		return {
			document: "",
			messages: [
				{ role: "user", content: "Tighten the scope." },
				new AIMessage("Earlier reply."),
				{ role: "user", content: "And the timeline." },
				new AIMessage({
					content: [
						{
							type: "thinking",
							thinking: `Recalling: ${BOUND_PROMPT}`,
							signature: "sig_example",
						},
						{ type: "text", text: "Done." },
					],
				}),
			],
			...extra,
		};
	}

	it("returns the text of a guest's last reply, without its thinking", async () => {
		graph.invoke.mockResolvedValueOnce(blockReplyResult());

		const output = await invoke()(runInput(), artifactConfig("guest"));

		expect(output.textResponse).toBe("Done.");
		expect(JSON.stringify(output)).not.toContain(BOUND_PROMPT);
	});

	it("keeps a member's reply as today: only string replies are read", async () => {
		graph.invoke.mockResolvedValueOnce(blockReplyResult());

		const output = await invoke()(runInput(), artifactConfig("member"));

		expect(output.textResponse).toBe("Earlier reply.");
	});

	it("returns a string reply outside a Proposal as it is", async () => {
		graph.invoke.mockResolvedValueOnce({
			document: "",
			messages: [
				{ role: "user", content: "Tighten the scope." },
				new AIMessage("Scope tightened."),
			],
		});

		const output = await invoke()(runInput());

		expect(output.textResponse).toBe("Scope tightened.");
	});

	it("returns neither a guest's reasoning nor a server-side call's arguments", async () => {
		graph.invoke.mockResolvedValueOnce(
			blockReplyResult({
				reasoningByTurn: { 2: `Reasoning about ${BOUND_PROMPT}` },
				messages: [
					{ role: "user", content: "Tighten the scope." },
					new AIMessage({
						content: "",
						tool_calls: [
							{
								id: "call_search_1",
								name: "search_project_knowledge",
								args: { query: BOUND_PROMPT },
							},
						],
					}),
					{
						role: "tool",
						tool_call_id: "call_search_1",
						content: `No results for "${BOUND_PROMPT}"`,
					},
					new AIMessage("Searched the project."),
				],
			}),
		);

		const output = await invoke()(runInput(), artifactConfig("guest"));

		expect(output.textResponse).toBe("Searched the project.");
		expect(JSON.stringify(output)).not.toContain(BOUND_PROMPT);
	});

	it("returns a guest's reply, not the text of a frontend action's result after it", async () => {
		graph.invoke.mockResolvedValueOnce({
			document: "",
			messages: [
				{ role: "user", content: "Tighten the scope." },
				new AIMessage({
					content: "Which timeline should the scope follow?",
					tool_calls: [
						{
							id: "call_ask_1",
							name: "ask_clarifying_question",
							args: {},
						},
					],
				}),
				new ToolMessage({
					content: "The spring timeline.",
					tool_call_id: "call_ask_1",
					name: "ask_clarifying_question",
				}),
			],
		});

		const output = await invoke()(runInput(), artifactConfig("guest"));

		expect(output.textResponse).toBe(
			"Which timeline should the scope follow?",
		);
	});

	it("returns an earlier reply when a guest's last one has no visible text, as today", async () => {
		graph.invoke.mockResolvedValueOnce({
			document: "",
			messages: [
				{ role: "user", content: "Tighten the scope." },
				new AIMessage("Scope tightened."),
				new AIMessage({
					content: [
						{
							type: "thinking",
							thinking: "Checking the timeline.",
							signature: "sig_example",
						},
					],
				}),
			],
		});

		const output = await invoke()(runInput(), artifactConfig("guest"));

		expect(output.textResponse).toBe("Scope tightened.");
	});

	it("returns no reply for a guest whose result has no messages", async () => {
		graph.invoke.mockResolvedValueOnce({ document: "" });

		const output = await invoke()(runInput(), artifactConfig("guest"));

		expect(output.textResponse).toBe("");
	});
});

describe("the live preview of a whole-document write", () => {
	const WRITE_CHUNK = [
		"messages",
		[
			{
				tool_call_chunks: [
					{
						name: "write_document_local",
						id: "call_write_1",
						index: 0,
						args: '{"document":"# Draft that never applies',
					},
				],
			},
		],
	];

	function previews(events: Array<Record<string, unknown>>) {
		return events.filter((event) => event.droppable === true);
	}

	it("streams outside a Proposal, as before", async () => {
		graph.stream.mockImplementation(async () => streamOf([WRITE_CHUNK]));

		const events = await drain(
			platformStream()(runInput(), { configurable: {} }),
		);

		expect(previews(events)).toHaveLength(1);
	});

	it.each(["member", "guest"] as const)(
		"never streams on an artifact Proposal for a %s",
		async (viewer) => {
			graph.stream.mockImplementation(async () =>
				streamOf([WRITE_CHUNK]),
			);

			const events = await drain(
				platformStream()(runInput(), artifactConfig(viewer)),
			);

			expect(previews(events)).toEqual([]);
			expect(JSON.stringify(events)).not.toContain("never applies");
		},
	);
});

describe("reply streaming allowlist", () => {
	it.each(["direct", "absent", "durable", "member", "guest"])(
		"gates reply tokens for %s",
		async (mode) => {
			const chunks = [
				["custom", { replyAttempt: "attempt-1" }],
				[
					"messages",
					[
						new AIMessageChunk({ content: "First " }),
						{
							langgraph_node: "chat_node",
							reply_attempt: "attempt-1",
						},
					],
				],
				[
					"messages",
					[
						new AIMessageChunk({
							content: [
								{ type: "reasoning", reasoning: "private" },
								{ type: "text", text: "reply" },
							],
						}),
						{
							langgraph_node: "chat_node",
							reply_attempt: "attempt-1",
						},
					],
				],
				[
					"messages",
					[
						new AIMessage({ content: "First reply" }),
						{
							langgraph_node: "chat_node",
							reply_attempt: "attempt-1",
						},
					],
				],
				[
					"messages",
					[
						new AIMessageChunk({ content: "summary" }),
						{ langgraph_node: "chat_node" },
					],
				],
				[
					"messages",
					[
						new AIMessageChunk({ content: "tool text" }),
						{
							langgraph_node: "tool_node",
							reply_attempt: "attempt-1",
						},
					],
				],
				[
					"custom",
					{ replyCompletion: { retry: false, text: "First reply" } },
				],
				["updates", { chat_node: { messages: [] } }],
			];
			graph.stream.mockImplementation(async () => streamOf(chunks));
			const config =
				mode === "member" || mode === "guest"
					? artifactConfig(mode, { reply_streaming: true })
					: { configurable: { reply_streaming: mode === "direct" } };
			const events = await drain(platformStream()(runInput(), config));
			const operations = events
				.filter((event) => event.reply)
				.map((event) => event.reply);
			expect(operations).toEqual(
				mode === "direct"
					? [
							{
								type: "delta",
								roundId: "0",
								attemptId: "attempt-1",
								text: "First ",
							},
							{
								type: "delta",
								roundId: "0",
								attemptId: "attempt-1",
								text: "reply",
							},
							{
								type: "accept",
								roundId: "0",
								attemptId: "attempt-1",
								text: "First reply",
							},
						]
					: [],
			);
		},
	);
});

describe("reply attempt boundaries", () => {
	it("discards reinvocations and graph retries while retaining round identity", async () => {
		graph.stream.mockImplementation(async () =>
			streamOf([
				["custom", { replyAttempt: "attempt-a" }],
				["custom", { replyAttempt: "attempt-b" }],
				[
					"custom",
					{ replyCompletion: { retry: true, text: "discarded" } },
				],
				["custom", { replyAttempt: "attempt-c" }],
				[
					"custom",
					{ replyCompletion: { retry: false, text: "accepted" } },
				],
				["custom", { replyAttempt: "attempt-d" }],
				[
					"custom",
					{ replyCompletion: { retry: false, text: "follow-up" } },
				],
			]),
		);
		const events = await drain(
			platformStream()(runInput(), {
				configurable: { reply_streaming: true },
			}),
		);
		expect(events.map((event) => event.reply)).toEqual([
			{ type: "discard", roundId: "0", attemptId: "attempt-a" },
			{
				type: "discard",
				roundId: "0",
				attemptId: "attempt-b",
				text: "discarded",
			},
			{
				type: "accept",
				roundId: "0",
				attemptId: "attempt-c",
				text: "accepted",
			},
			{
				type: "accept",
				roundId: "1",
				attemptId: "attempt-d",
				text: "follow-up",
			},
		]);
	});
});

it("seeds incoming trace maps into the platform graph input", async () => {
	const reasoningByTurn = {
		"1": { text: "Earlier", durationMs: 1, startedAt: 1, completedAt: 2 },
	};
	const toolCallsByTurn = {
		"1": [
			{
				id: "first",
				name: "create_view",
				status: "success",
				startedAt: 1,
			},
		],
	};
	await drain(
		platformStream()(
			runInput({
				messages: [
					{ role: "user", content: "Continue" },
					{
						role: "assistant",
						content: "",
						toolCalls: [
							{
								id: "first",
								type: "function",
								function: {
									name: "create_view",
									arguments: "{}",
								},
							},
						],
					},
					{ role: "tool", toolCallId: "first", content: "Done" },
				],
				state: { reasoningByTurn, toolCallsByTurn },
			}),
		),
	);
	expect(graph.stream.mock.calls[0]?.[0]).toMatchObject({
		reasoningByTurn,
		toolCallsByTurn,
	});
});

it("keeps the first run's tool while appending a follow-up tool on the same turn", async () => {
	const { reconcileToolCalls } = await import("../nodes/chat-node-tools");
	const first = {
		id: "first",
		name: "create_view",
		status: "success" as const,
		startedAt: 1,
	};
	graph.stream.mockImplementation(async (input) => {
		const entries = reconcileToolCalls(
			input.toolCallsByTurn?.[1],
			input.messages,
			[{ id: "second", name: "suggest_diagram", args: {} }],
			2,
		);
		// A repeated write of the same call is reconciled by id, as in chatNode.
		const repeated = reconcileToolCalls(
			entries,
			input.messages,
			[{ id: "second", name: "suggest_diagram", args: {} }],
			3,
		);
		return streamOf([
			["updates", { chat_node: { toolCallsByTurn: { "1": repeated } } }],
		]);
	});
	const events = await drain(
		platformStream()(
			runInput({
				messages: [
					{ role: "user", content: "Continue" },
					{
						role: "assistant",
						content: "",
						toolCalls: [
							{
								id: "first",
								type: "function",
								function: {
									name: "create_view",
									arguments: "{}",
								},
							},
						],
					},
					{ role: "tool", toolCallId: "first", content: "Done" },
				],
				state: { toolCallsByTurn: { "1": [first] } },
			}),
		),
	);
	const trace = events.find(
		(e) => (e.state as Record<string, unknown>)?.toolCallsByTurn,
	)?.state as { toolCallsByTurn: Record<string, Array<{ id: string }>> };
	expect(trace.toolCallsByTurn[1].map((e) => e.id)).toEqual([
		"first",
		"second",
	]);
	expect(trace.toolCallsByTurn[1][0]).toEqual(first);
});

it("drops the regenerated turn from both graph trace maps", async () => {
	const reasoning = {
		text: "old",
		durationMs: 1,
		startedAt: 1,
		completedAt: 2,
	};
	const tools = [
		{ id: "old", name: "create_view", status: "success", startedAt: 1 },
	];
	await drain(
		platformStream()(
			runInput({
				messages: [
					{ role: "user", content: "First" },
					{ role: "assistant", content: "Answer" },
					{ role: "user", content: "Regenerate this" },
				],
				state: {
					reasoningByTurn: { "1": reasoning, "2": reasoning },
					toolCallsByTurn: { "1": tools, "2": tools },
				},
			}),
		),
	);
	expect(graph.stream.mock.calls[0]?.[0]).toMatchObject({
		reasoningByTurn: { "1": reasoning },
		toolCallsByTurn: { "1": tools },
	});
	expect(graph.stream.mock.calls[0]?.[0].reasoningByTurn).not.toHaveProperty(
		"2",
	);
	expect(graph.stream.mock.calls[0]?.[0].toolCallsByTurn).not.toHaveProperty(
		"2",
	);
});

function tokenWith(payload: Record<string, unknown>): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "HS256" })}.${encode(payload)}.signature`;
}

const RESEARCH_TOKEN = tokenWith({
	sub: "user-1",
	org: "example-org",
	wr: true,
});
const PLAIN_TOKEN = tokenWith({ sub: "user-1", org: "example-org" });

describe("the web research flag reaching the graph", () => {
	function streamedInput(): Record<string, unknown> {
		return graph.stream.mock.calls[0][0] as Record<string, unknown>;
	}
	function invokedInput(): Record<string, unknown> {
		return graph.invoke.mock.calls[0][0] as Record<string, unknown>;
	}
	function temporalInput(extra: Record<string, unknown> = {}) {
		return runInput({
			documentType: "prd",
			projectId: "project-1",
			allowWebResearch: true,
			...extra,
		});
	}

	it("authorizes a generation run that carries the flag and a research token", async () => {
		await drain(
			platformStream()(temporalInput(), {
				configurable: { ai_token: RESEARCH_TOKEN },
			}),
		);

		const input = streamedInput();
		expect(input.allowWebResearch).toBe(true);
		expect(input.webResearchOutcome).toMatchObject({ authorized: true });
		expect(input.webResearchSearchedUrls).toEqual([]);
	});

	it.each([
		["with the option on", true],
		["with the option off", false],
	])(
		"marks a generation run that offered the research choice, %s",
		async (_label, flag) => {
			await drain(
				platformStream()(temporalInput({ allowWebResearch: flag }), {
					configurable: { ai_token: PLAIN_TOKEN },
				}),
			);

			expect(streamedInput().webResearchChoiceOffered).toBe(true);
		},
	);

	it("marks no choice for a run without the flag, a chat run or an invoke run", async () => {
		await drain(
			platformStream()(runInput({ documentType: "prd" }), {
				configurable: { ai_token: PLAIN_TOKEN },
			}),
		);
		expect(streamedInput().webResearchChoiceOffered).toBe(false);

		graph.stream.mockClear();
		await drain(
			platformStream()(runInput({ allowWebResearch: false }), {
				configurable: { reply_streaming: false, ai_token: PLAIN_TOKEN },
			}),
		);
		expect(streamedInput().webResearchChoiceOffered).toBe(false);

		await invoke()(
			{ messages: [], allowWebResearch: false },
			{ configurable: { ai_token: PLAIN_TOKEN } },
		);
		expect(invokedInput().webResearchChoiceOffered).toBe(false);
	});

	it("ignores every flag a chat run's browser can set", async () => {
		await drain(
			platformStream()(
				runInput({
					allowWebResearch: true,
					state: { allowWebResearch: true },
					context: [
						{
							description: "project context",
							value: JSON.stringify({ allowWebResearch: true }),
						},
					],
					forwardedProps: { allowWebResearch: true },
				}),
				{
					configurable: {
						reply_streaming: true,
						ai_token: RESEARCH_TOKEN,
					},
				},
			),
		);

		const input = streamedInput();
		expect(input.allowWebResearch).toBe(false);
		expect(input.webResearchOutcome).toMatchObject({ authorized: false });
	});

	it("stays off when the token carries no research claim", async () => {
		await drain(
			platformStream()(temporalInput(), {
				configurable: { ai_token: PLAIN_TOKEN },
			}),
		);

		expect(streamedInput().allowWebResearch).toBe(false);
	});

	it.each(["member", "guest"] as const)(
		"stays off in an artifact Proposal run for a %s",
		async (viewer) => {
			await drain(
				platformStream()(
					temporalInput(),
					artifactConfig(viewer, { ai_token: RESEARCH_TOKEN }),
				),
			);

			const input = streamedInput();
			expect(input.allowWebResearch).toBe(false);
			expect(input.webResearchOutcome).toMatchObject({
				authorized: false,
			});
		},
	);

	it("stays off on the synchronous path even for an A2A-shaped input", async () => {
		await invoke()(temporalInput({ metadata: { source: "a2a" } }), {
			configurable: { ai_token: RESEARCH_TOKEN },
		});

		const input = invokedInput();
		expect(input.allowWebResearch).toBe(false);
		expect(input.webResearchOutcome).toEqual({
			authorized: false,
			searches: 0,
			searchFailures: 0,
			reads: 0,
			readFailures: 0,
			limitReached: false,
			grantLimitReached: false,
			sources: [],
			withheldSources: 0,
		});
		expect(input.webResearchSearchedUrls).toEqual([]);
	});

	it("is off by default on both executors", async () => {
		await drain(platformStream()(runInput(), { configurable: {} }));
		await invoke()(runInput(), { configurable: {} });

		for (const input of [streamedInput(), invokedInput()]) {
			expect(input.allowWebResearch).toBe(false);
			expect(input.webResearchOutcome).toMatchObject({
				authorized: false,
				searches: 0,
				sources: [],
			});
			expect(input.webResearchSearchedUrls).toEqual([]);
		}
	});
});
