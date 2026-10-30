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
