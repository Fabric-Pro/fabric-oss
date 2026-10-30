import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { LangGraphExecutor } from "@repo/agent-core/unified-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
	invoke: vi.fn().mockResolvedValue({ messages: [] }),
	stream: vi.fn().mockImplementation(async function* () {}),
	run: undefined as LangGraphExecutor | undefined,
	streamRun: undefined as
		| ((input: Record<string, unknown>) => AsyncIterable<unknown>)
		| undefined,
}));
vi.mock("@repo/agent-core/unified-server", () => ({
	createUnifiedServer: (...args: unknown[]) => {
		captured.run = args[1] as typeof captured.run;
		captured.streamRun = args[4] as typeof captured.streamRun;
		return { app: {}, start: vi.fn() };
	},
}));
vi.mock("../agent.js", () => ({
	projectDocumentGeneratorGraph: {
		invoke: captured.invoke,
		stream: captured.stream,
	},
}));
import "../unified-server";
import { PROPOSAL_GUEST_ERROR_REPLY } from "../nodes/proposal-client-mode";

beforeEach(() => vi.clearAllMocks());

it.each([
	["invoke", true],
	["invoke", false],
	["invoke", undefined],
	["stream", true],
	["stream", false],
	["stream", undefined],
] as const)(
	"%s forwards the prompt and explicit methodology opt-out (flag=%s)",
	async (mode, flag) => {
		const input = {
			messages: [],
			state: {
				systemPrompt: "Clean Spec",
				...(flag === undefined
					? {}
					: { suppressFabricMethodology: flag }),
			},
		};
		if (mode === "invoke") {
			await captured.run?.(input);
		} else {
			for await (const _event of captured.streamRun?.(input) ?? []) {
				// The graph stub produces no events.
			}
		}
		const graphCall = mode === "invoke" ? captured.invoke : captured.stream;
		expect(graphCall.mock.calls.at(-1)?.[0]).toMatchObject({
			systemPrompt: "Clean Spec",
			suppressFabricMethodology: flag === true,
		});
	},
);

// A classified Proposal run (Fizzy #2946): its prompt is run config, so the
// client's state may not steer it, and its logs keep to ids and counts.

const CLIENT_STATE = {
	systemPrompt: "Client state prompt",
	suppressFabricMethodology: true,
	activeSkill: { slug: "example-skill", skillMd: "skill", files: [] },
	document: "# Example Proposal\n\nSECRET DOCUMENT TEXT for Example Org.",
	copilotkit: {
		actions: [
			{
				name: "confirm_changes",
				description: "Confirm.",
				parameters: [],
			},
			{ name: "suggest_diagram", description: "Insert.", parameters: [] },
			{
				name: "regenerate_document",
				description: "Rewrite.",
				parameters: [],
			},
		],
	},
};
const MESSAGE_TEXT = "SECRET MESSAGE TEXT about the hosting decision";
const BOUND_PROMPT = "SECRET BOUND PROMPT for the client revision";

async function streamWith(proposalMode: string) {
	const streamRun = captured.streamRun as unknown as (
		input: Record<string, unknown>,
		config: Record<string, unknown>,
	) => AsyncIterable<unknown>;
	const input = {
		messages: [{ id: "m1", role: "user", content: MESSAGE_TEXT }],
		state: CLIENT_STATE,
	};
	for await (const _event of streamRun(input, {
		configurable: {
			proposal_mode: proposalMode,
			proposal_client_prompt: BOUND_PROMPT,
		},
	})) {
		// The graph stub produces no events.
	}
	return captured.stream.mock.calls.at(-1)?.[0] as Record<string, any>;
}

function loggedText(spies: Array<ReturnType<typeof vi.spyOn>>): string {
	return spies
		.flatMap((spy) => spy.mock.calls.map((args) => JSON.stringify(args)))
		.join("\n");
}

describe("stream on a client-document Proposal", () => {
	let spies: Array<ReturnType<typeof vi.spyOn>> = [];
	beforeEach(() => {
		spies = (["log", "info", "warn", "error", "debug"] as const).map(
			(method) => vi.spyOn(console, method).mockImplementation(() => {}),
		);
	});
	afterEach(() => {
		for (const spy of spies) {
			spy.mockRestore();
		}
	});

	it("drops the client's prompt, methodology opt-out and skill on an artifact run", async () => {
		const state = await streamWith("artifact");
		expect(state.systemPrompt).toBeUndefined();
		expect(state.suppressFabricMethodology).toBe(false);
		expect(state.activeSkill).toBeUndefined();
	});

	it("forwards them outside a Proposal", async () => {
		const state = await streamWith("none");
		expect(state.systemPrompt).toBe("Client state prompt");
		expect(state.suppressFabricMethodology).toBe(true);
		expect(state.activeSkill).toEqual(CLIENT_STATE.activeSkill);
	});

	it("offers only the frontend actions that leave the document alone on an artifact run", async () => {
		const artifact = await streamWith("artifact");
		expect(
			artifact.copilotkit.actions.map((a: { name: string }) => a.name),
		).toEqual(["confirm_changes", "regenerate_document"]);
		// As the agent defines them: the browser's "Rewrite." never binds.
		expect(artifact.copilotkit.actions[1].description).toContain(
			"Fully regenerate document content from scratch",
		);
		expect(JSON.stringify(artifact.copilotkit.actions)).not.toContain(
			"Rewrite.",
		);

		const none = await streamWith("none");
		expect(
			none.copilotkit.actions.map((a: { name: string }) => a.name),
		).toEqual([
			"confirm_changes",
			"suggest_diagram",
			"regenerate_document",
		]);
	});

	it.each(["artifact", "unbound", "unverified"])(
		"logs no message, document or prompt text on a %s run",
		async (mode) => {
			await streamWith(mode);
			const logs = loggedText(spies);
			expect(logs).not.toBe("");
			expect(logs).not.toContain("SECRET MESSAGE TEXT");
			expect(logs).not.toContain("SECRET DOCUMENT TEXT");
			expect(logs).not.toContain("SECRET BOUND PROMPT");
			expect(logs).not.toContain("Client state prompt");
		},
	);

	it("still previews the message and document outside a Proposal", async () => {
		await streamWith("none");
		const logs = loggedText(spies);
		expect(logs).toContain("SECRET MESSAGE TEXT");
		expect(logs).toContain("SECRET DOCUMENT TEXT");
	});
});

// What the stream sends a guest on an artifact Proposal (Fizzy #2946): each
// assistant message as its reply and tool calls only, and no reasoning. The
// graph's own state keeps the rest for an in-run replay to the provider.

describe("stream updates a guest receives on a client-document Proposal", () => {
	const REASONING = "SECRET REASONING about the bound instructions";
	let spies: Array<ReturnType<typeof vi.spyOn>> = [];
	beforeEach(() => {
		spies = (["log", "info", "warn", "error", "debug"] as const).map(
			(method) => vi.spyOn(console, method).mockImplementation(() => {}),
		);
	});
	afterEach(() => {
		for (const spy of spies) {
			spy.mockRestore();
		}
	});

	function chatNodeUpdate() {
		return {
			chat_node: {
				messages: [
					new HumanMessage("Tighten the scope."),
					new AIMessage({
						id: "ai_1",
						content: [
							{
								type: "thinking",
								thinking: REASONING,
								signature: "sig_example",
							},
							{ type: "text", text: "Changes ready for review." },
						],
						tool_calls: [
							{
								id: "call_confirm_1",
								name: "confirm_changes",
								args: { accepted: null },
								type: "tool_call" as const,
							},
						],
						additional_kwargs: { reasoning_content: REASONING },
						response_metadata: {
							output: [
								{
									type: "reasoning",
									summary: [
										{
											type: "summary_text",
											text: REASONING,
										},
									],
								},
							],
						},
					}),
				],
				reasoningByTurn: { 1: { text: REASONING, durationMs: 1 } },
			},
		};
	}

	async function streamedStates(
		viewer: string,
		chunks: unknown[] = [["updates", chatNodeUpdate()]],
	) {
		captured.stream.mockImplementationOnce(async function* () {
			yield* chunks;
		});
		const streamRun = captured.streamRun as unknown as (
			input: Record<string, unknown>,
			config: Record<string, unknown>,
		) => AsyncIterable<{ state: Record<string, any> }>;
		const states: Array<Record<string, any>> = [];
		for await (const event of streamRun(
			{ messages: [{ id: "m1", role: "user", content: MESSAGE_TEXT }] },
			{
				configurable: {
					proposal_mode: "artifact",
					proposal_client_prompt: BOUND_PROMPT,
					proposal_viewer: viewer,
				},
			},
		)) {
			states.push(event.state);
		}
		return states;
	}

	it("sends a guest the reply and tool calls without any reasoning", async () => {
		const states = await streamedStates("guest");
		expect(states).toHaveLength(1);
		expect(JSON.stringify(states)).not.toContain("SECRET REASONING");
		expect(states[0]).not.toHaveProperty("reasoningByTurn");
		expect(states[0].messages.at(-1)).toEqual({
			type: "ai",
			id: "ai_1",
			content: "Changes ready for review.",
			tool_calls: [
				{
					id: "call_confirm_1",
					name: "confirm_changes",
					args: { accepted: null },
					type: "tool_call",
				},
			],
		});
	});

	it("sends a member the update as the graph produced it", async () => {
		const states = await streamedStates("member");
		expect(JSON.stringify(states)).toContain("SECRET REASONING");
		expect(states[0]).toHaveProperty("reasoningByTurn");
	});

	it("sends a guest no server-side call's arguments or result, and neither viewer a write preview", async () => {
		const chunks = [
			[
				"messages",
				[
					{
						tool_call_chunks: [
							{
								name: "write_document_local",
								args: '{"document": "SECRET PREVIEW TEXT',
								id: "call_write_1",
								index: 0,
							},
						],
					},
					{},
				],
			],
			[
				"updates",
				{
					chat_node: {
						messages: [
							new AIMessage({
								content: "Searching.",
								tool_calls: [
									{
										id: "call_search_1",
										name: "search_project_knowledge",
										args: { query: "SECRET QUERY TEXT" },
										type: "tool_call" as const,
									},
								],
							}),
						],
					},
				},
			],
			[
				"updates",
				{
					tools: {
						messages: [
							new ToolMessage({
								content:
									'No Teams messages found for "SECRET QUERY TEXT".',
								tool_call_id: "call_search_1",
								name: "search_teams_messages",
							}),
						],
					},
				},
			],
		];

		const guest = JSON.stringify(await streamedStates("guest", chunks));
		expect(guest).not.toContain("SECRET QUERY TEXT");
		expect(guest).not.toContain("SECRET PREVIEW TEXT");

		// An artifact Proposal refuses a whole-document write, so a member is
		// not shown a preview of one either.
		const member = JSON.stringify(await streamedStates("member", chunks));
		expect(member).toContain("SECRET QUERY TEXT");
		expect(member).not.toContain("SECRET PREVIEW TEXT");
	});
});

// A guest's failed run on a client-document Proposal (Fizzy #2946): the
// server turns a thrown error's message into the browser's RUN_ERROR, and a
// provider's error can repeat the request.

describe("a failed stream on a client-document Proposal", () => {
	let spies: Array<ReturnType<typeof vi.spyOn>> = [];
	beforeEach(() => {
		spies = (["log", "info", "warn", "error", "debug"] as const).map(
			(method) => vi.spyOn(console, method).mockImplementation(() => {}),
		);
	});
	afterEach(() => {
		for (const spy of spies) {
			spy.mockRestore();
		}
	});

	async function failedStream(configurable: Record<string, unknown>) {
		captured.stream.mockImplementationOnce(async function* () {
			yield ["updates", { chat_node: { messages: [] } }];
			throw Object.assign(
				new Error(`Provider rejected the request: ${BOUND_PROMPT}`),
				{ status: 400, code: "invalid_request_error" },
			);
		});
		const streamRun = captured.streamRun as unknown as (
			input: Record<string, unknown>,
			config: Record<string, unknown>,
		) => AsyncIterable<unknown>;
		try {
			for await (const _event of streamRun(
				{ messages: [{ id: "m1", role: "user", content: "Hi" }] },
				{ configurable },
			)) {
				// The first update passes; the failure follows it.
			}
		} catch (error) {
			return error as Error;
		}
		throw new Error("the stream did not fail");
	}

	it("ends a guest's run with one generic error and logs its codes only", async () => {
		const error = await failedStream({
			proposal_mode: "artifact",
			proposal_client_prompt: BOUND_PROMPT,
			proposal_viewer: "guest",
		});

		expect(error.message).toBe(PROPOSAL_GUEST_ERROR_REPLY);
		expect(error.cause).toBeUndefined();
		const logs = loggedText(spies);
		expect(logs).not.toContain("Provider rejected");
		expect(logs).not.toContain("SECRET BOUND PROMPT");
		expect(logs).toContain("invalid_request_error");
		expect(logs).toContain("400");
	});

	it.each([
		[
			"a member",
			{
				proposal_mode: "artifact",
				proposal_client_prompt: BOUND_PROMPT,
				proposal_viewer: "member",
			},
		],
		["a run outside a Proposal", { proposal_mode: "none" }],
	])("passes the error of %s as it is", async (_label, configurable) => {
		const error = await failedStream(configurable);
		expect(error.message).toBe(
			`Provider rejected the request: ${BOUND_PROMPT}`,
		);
	});
});

// Client-supplied context on a client-document Proposal (Fizzy #2946): an
// artifact run sets no client text beside the bound prompt, wherever the
// client sent it, and keeps the project id its tools need.

describe("client-supplied context on a client-document Proposal", () => {
	let spies: Array<ReturnType<typeof vi.spyOn>> = [];
	beforeEach(() => {
		spies = (["log", "info", "warn", "error", "debug"] as const).map(
			(method) => vi.spyOn(console, method).mockImplementation(() => {}),
		);
	});
	afterEach(() => {
		for (const spy of spies) {
			spy.mockRestore();
		}
	});

	const PROJECT_CONTEXT = {
		name: "CLIENT PROJECT NAME",
		techStack: ["CLIENT STACK"],
		features: ["CLIENT FEATURE"],
	};

	async function streamClientContext(proposalMode: string) {
		const streamRun = captured.streamRun as unknown as (
			input: Record<string, unknown>,
			config: Record<string, unknown>,
		) => AsyncIterable<unknown>;
		const input = {
			messages: [{ id: "m1", role: "user", content: "Hi" }],
			state: {
				ragContexts: ["STATE ATTACHMENT"],
				refreshSpecContexts: ["STATE REFRESH CONTEXT"],
				projectContext: PROJECT_CONTEXT,
			},
			context: [
				{
					description: "RAG context — files attached in this chat",
					value: JSON.stringify({
						ragContexts: ["READABLE ATTACHMENT"],
					}),
				},
				{
					description: "Project context including name",
					value: JSON.stringify({
						projectContext: PROJECT_CONTEXT,
						projectId: "project_example",
						hasTeamsIntegration: true,
					}),
				},
			],
			ragContexts: ["INPUT ATTACHMENT"],
			projectContext: PROJECT_CONTEXT,
		};
		for await (const _event of streamRun(input, {
			configurable: {
				proposal_mode: proposalMode,
				proposal_client_prompt: BOUND_PROMPT,
			},
		})) {
			// The graph stub produces no events.
		}
		return captured.stream.mock.calls.at(-1)?.[0] as Record<string, any>;
	}

	it("hands an artifact run's graph no project or rag context, and keeps the project id and flags", async () => {
		const state = await streamClientContext("artifact");
		expect(state.ragContexts).toEqual([]);
		expect(state.projectContext).toEqual({
			name: "",
			techStack: [],
			features: [],
		});
		expect(state.projectId).toBe("project_example");
		expect(state.hasTeamsIntegration).toBe(true);
	});

	it("hands them on outside a Proposal", async () => {
		const state = await streamClientContext("none");
		expect(state.ragContexts).toEqual([
			"READABLE ATTACHMENT",
			"STATE REFRESH CONTEXT",
		]);
		expect(state.projectContext).toEqual(PROJECT_CONTEXT);
		expect(state.projectId).toBe("project_example");
	});
});
