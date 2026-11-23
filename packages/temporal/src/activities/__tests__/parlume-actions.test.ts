import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parlumeActionOutcome } from "../parlume-action-policy";
import {
	createParlumeToolRuntime,
	type ParlumeActionContext,
} from "../parlume-actions";
import type { AgentToolInvocation } from "../shared/agent-tool-runtime";

const state = vi.hoisted(() => {
	const initial: {
		session: Record<string, unknown>;
		actions: Array<Record<string, unknown>>;
		access: boolean;
		proposal: ReturnType<typeof vi.fn>;
	} = {
		session: {},
		actions: [],
		access: true,
		proposal: vi.fn(),
	};
	return initial;
});
vi.mock("../parlume-voice", () => ({
	postParlumeProposal: state.proposal,
}));

function matches(
	row: Record<string, unknown>,
	where: Record<string, unknown>,
): boolean {
	return Object.entries(where).every(([key, expected]) => {
		if (key === "turnId_invocationKey") {
			const pair = expected as { turnId: string; invocationKey: string };
			return (
				row.turnId === pair.turnId &&
				row.invocationKey === pair.invocationKey
			);
		}
		return row[key] === expected;
	});
}

vi.mock("@repo/database", () => {
	const session = {
		findFirst: vi.fn(
			async ({ where }: { where: Record<string, unknown> }) =>
				matches(state.session, where)
					? structuredClone(state.session)
					: null,
		),
	};
	const action = {
		createMany: vi.fn(
			async ({ data }: { data: Record<string, unknown> }) => {
				if (
					state.actions.some(
						(row) =>
							row.turnId === data.turnId &&
							row.invocationKey === data.invocationKey,
					)
				) {
					return { count: 0 };
				}
				state.actions.push(structuredClone(data));
				return { count: 1 };
			},
		),
		findUnique: vi.fn(
			async ({ where }: { where: Record<string, unknown> }) => {
				const found = state.actions.find((row) => matches(row, where));
				return found ? structuredClone(found) : null;
			},
		),
		update: vi.fn(
			async ({
				where,
				data,
			}: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				const found = state.actions.find((row) => matches(row, where));
				if (found) {
					Object.assign(found, structuredClone(data));
				}
				return structuredClone(found);
			},
		),
	};
	return {
		db: {
			parlumeMeetingSession: session,
			parlumeAction: action,
			project: {
				findUnique: vi.fn(async () => ({ name: "Example project" })),
			},
		},
		buildParlumeActionUrl: vi.fn(
			async (input: { actionId: string; intent?: string }) =>
				`https://app.example.com/app/example-org/projects/project/parlume/actions/${input.actionId}${input.intent ? `?intent=${input.intent}` : ""}`,
		),
		hasProjectAccess: vi.fn(async () => state.access),
		canEditProject: vi.fn(async () => state.access),
	};
});

const context: ParlumeActionContext = {
	turnId: "request",
	sessionId: "session",
	projectId: "project",
	organizationId: "org",
	userId: "user",
	speakerId: "speaker-a",
	speakerName: "Alex",
	requestText: "create a feature called Export to CSV",
	agentRevision: "revision",
	voiceGeneration: 3,
	toolsReadOnly: false,
};
const inputSchema = z.object({
	title: z.string(),
	priority: z.string().optional(),
});
const execute = vi.fn(async (): Promise<unknown> => ({ success: true }));

function call(
	overrides: Partial<AgentToolInvocation> & { args?: unknown } = {},
): AgentToolInvocation {
	return {
		name: "fabric_create_story",
		description: "Create a feature",
		inputSchema,
		source: { configId: "builtin", originalName: "fabric_create_story" },
		args: { title: "Export to CSV", priority: "High" },
		delegates: false,
		execute: () => execute(),
		...overrides,
	};
}

function actionRow() {
	return state.actions[0];
}

beforeEach(() => {
	vi.clearAllMocks();
	state.actions = [];
	state.access = true;
	state.proposal.mockResolvedValue({ sent: true, tag: "P7" });
	state.session = {
		id: "session",
		projectId: "project",
		organizationId: "org",
		userId: "user",
		status: "ACTIVE",
		voiceGeneration: 3,
		toolsReadOnly: false,
	};
	execute.mockResolvedValue({ success: true });
});

describe("Parlume proposes every change", () => {
	it("records a write as a proposal and makes no change", async () => {
		const result = await createParlumeToolRuntime(context).invoke(call());

		expect(execute).not.toHaveBeenCalled();
		expect(result).toMatchObject({ proposed: true, changed: false });
		expect(actionRow()).toMatchObject({
			sessionId: "session",
			projectId: "project",
			userId: "user",
			speakerId: "speaker-a",
			speakerName: "Alex",
			toolConfigId: "builtin",
			toolOriginalName: "fabric_create_story",
			arguments: { title: "Export to CSV", priority: "High" },
			summary: "Create feature “Export to CSV”",
			status: "PROPOSED",
			chatTag: "P7",
			presentedAt: expect.any(Date),
		});
	});

	it("keeps a proposal open for 24 hours", async () => {
		const before = Date.now();

		await createParlumeToolRuntime(context).invoke(call());

		const expiresAt = (actionRow()?.expiresAt as Date).getTime();
		expect(expiresAt - before).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
		expect(expiresAt - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
	});

	it("posts the proposal with its Confirm and Dismiss links, tag first and under 1,500 characters", async () => {
		await createParlumeToolRuntime(context).invoke(call());

		const actionId = String(actionRow()?.id);
		const confirmUrl = `https://app.example.com/app/example-org/projects/project/parlume/actions/${actionId}`;
		expect(state.proposal).toHaveBeenCalledWith({
			sessionId: "session",
			turnId: "request",
			voiceGeneration: 3,
			actionId,
			message: [
				"**Proposed change** · not made yet",
				"Create feature “Export to CSV” in Example project",
				"Asked by Alex: “create a feature called Export to CSV”",
				"Priority: High",
				`[Confirm in Fabric](${confirmUrl}) · [Dismiss](${confirmUrl}?intent=dismiss)`,
				"Only a signed-in project member can confirm. Open for 24 hours.",
			].join("\n"),
			spoken: "Proposed change, not made yet: Create feature “Export to CSV”. A signed-in project member can confirm it in Fabric.",
			confirmUrl,
			dismissUrl: `${confirmUrl}?intent=dismiss`,
		});
		const message = String(state.proposal.mock.calls[0]?.[0].message);
		expect(`[P7] ${message}`.length).toBeLessThan(1_500);
	});

	it("tells the agent the change waits for a member, naming the tag", async () => {
		const result = await createParlumeToolRuntime(context).invoke(call());

		expect(result).toMatchObject({
			instruction: expect.stringContaining("P7 waits for a member"),
		});
		expect(JSON.stringify(result)).not.toMatch(/go P7/);
	});

	// "Create a bug … Sync it to the tracker and assign it to Sam" got only
	// "P76 waits for a member to confirm it in Fabric." in three of three
	// requests: nothing said the sync and the assignment were not done.
	it("asks the agent to name the parts of the request the proposal does not do", async () => {
		const result = await createParlumeToolRuntime(context).invoke(call());

		expect(result).toMatchObject({
			instruction: expect.stringMatching(
				/does not do.*syncing the item to another tool, assigning it to someone.*those parts are not done, naming each/,
			),
		});
	});

	it("asks for the parts left out also when the chat is out of reach", async () => {
		state.proposal.mockResolvedValue({
			sent: false,
			reason: "chat_unavailable",
		});

		const result = await createParlumeToolRuntime(context).invoke(call());

		expect(result).toMatchObject({
			instruction: expect.stringContaining("those parts are not done"),
		});
	});

	it("points to the Parlume page when the chat is out of reach", async () => {
		state.proposal.mockResolvedValue({
			sent: false,
			reason: "chat_unavailable",
		});

		const result = await createParlumeToolRuntime(context).invoke(call());

		expect(result).toMatchObject({
			instruction: expect.stringContaining("Parlume page"),
		});
		expect(actionRow()).toMatchObject({ status: "PROPOSED" });
		expect(actionRow()).not.toHaveProperty("chatTag");
	});

	it("records a speaker Teams could not name", async () => {
		await createParlumeToolRuntime({ ...context, speakerId: null }).invoke(
			call(),
		);

		expect(actionRow()).toMatchObject({ speakerId: "unattributed" });
	});

	it("proposes one identical call once in a turn, and says so to the second", async () => {
		const runtime = createParlumeToolRuntime(context);

		await runtime.invoke(call());
		const second = await runtime.invoke(call());

		expect(state.actions).toHaveLength(1);
		expect(state.proposal).toHaveBeenCalledTimes(1);
		expect(second).toMatchObject({ alreadyProposed: true });
	});

	it("proposes two different changes in one turn", async () => {
		const runtime = createParlumeToolRuntime(context);

		await runtime.invoke(call({ args: { title: "First" } }));
		await runtime.invoke(call({ args: { title: "Second" } }));

		expect(state.actions).toHaveLength(2);
		expect(execute).not.toHaveBeenCalled();
	});

	it("does not propose a change through a connection, which would run with the inviter's credentials", async () => {
		const result = await createParlumeToolRuntime(context).invoke(
			call({
				name: "connection_b_create_ticket",
				source: {
					configId: "connection-b",
					originalName: "create_ticket",
				},
			}),
		);

		expect(result).toMatchObject({
			error: expect.stringContaining("agent chat"),
		});
		expect(execute).not.toHaveBeenCalled();
		expect(state.actions).toEqual([]);
	});

	it("still runs a read at once", async () => {
		await createParlumeToolRuntime(context).invoke(
			call({
				name: "fabric_list_project_features",
				source: {
					configId: "builtin",
					originalName: "fabric_list_project_features",
				},
				args: {},
			}),
		);

		expect(execute).toHaveBeenCalledTimes(1);
		expect(state.actions).toEqual([]);
	});

	it("does not propose a change when the inviter's access changed", async () => {
		state.access = false;

		const result = await createParlumeToolRuntime(context).invoke(call());

		expect(result).toMatchObject({
			error: expect.stringContaining("Ask again"),
		});
		expect(state.actions).toEqual([]);
	});

	it("refuses a call that carries credentials, without recording it", async () => {
		const result = await createParlumeToolRuntime(context).invoke(
			call({ args: { title: "x", apiKey: "example" } }),
		);

		expect(result).toMatchObject({
			error: expect.stringContaining("credentials"),
		});
		expect(state.actions).toEqual([]);
	});
});

describe("Parlume read-only meetings and project scope", () => {
	it("refuses every write in a read-only meeting without recording one", async () => {
		state.session.toolsReadOnly = true;

		const result = await createParlumeToolRuntime({
			...context,
			toolsReadOnly: true,
		}).invoke(call());

		expect(result).toMatchObject({
			error: expect.stringContaining("read-only"),
		});
		expect(execute).not.toHaveBeenCalled();
		expect(state.actions).toEqual([]);
	});
	it("refuses a built-in write that names another project", async () => {
		const result = await createParlumeToolRuntime(context).invoke(
			call({ args: { title: "x", projectId: "other" } }),
		);

		expect(result).toMatchObject({
			error: expect.stringContaining("own project"),
		});
		expect(state.actions).toEqual([]);
	});
	it("classifies a namespaced read by its original tool name", async () => {
		state.session.toolsReadOnly = true;

		await createParlumeToolRuntime({
			...context,
			toolsReadOnly: true,
		}).invoke(
			call({
				name: "project_context_get_feature",
				source: {
					configId: "builtin",
					originalName: "fabric_get_project_feature",
				},
				args: { id: "feature" },
			}),
		);

		expect(state.actions).toEqual([]);
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it("asks the agent's tools to draft work items afterwards, so a voice reply is not held for a model", () => {
		expect(createParlumeToolRuntime(context).deferStoryDrafting).toBe(true);
	});
});

describe("Parlume outcome evidence", () => {
	it.each([
		[{ success: true }, "COMPLETED"],
		[
			{ success: false, error: "Not allowed", authorityRequired: true },
			"FAILED",
		],
		[{ requiresConfirmation: true, workflowId: "workflow" }, "FAILED"],
		[
			{ isError: true, content: [{ type: "text", text: "Denied" }] },
			"FAILED",
		],
		[{ error: "MCP tool did not respond" }, "OUTCOME_UNKNOWN"],
		[
			{ success: true, status: "unconfirmed", executionId: "execution" },
			"OUTCOME_UNKNOWN",
		],
		[{ success: true, status: "queued" }, "OUTCOME_UNKNOWN"],
		[{ content: [{ type: "text", text: "Submitted" }] }, "OUTCOME_UNKNOWN"],
	])("classifies %j as %s", (result, expected) => {
		expect(parlumeActionOutcome(result)).toBe(expected);
	});
});

describe("Parlume meeting chat tool in the runtime", () => {
	const chat = call({
		name: "post_to_meeting_chat",
		source: { configId: "parlume", originalName: "post_to_meeting_chat" },
		args: { text: "Hello" },
	});

	it("is offered to the agent as a tool of the runtime", () => {
		expect(
			Object.keys(createParlumeToolRuntime(context).tools ?? {}),
		).toEqual(["post_to_meeting_chat", "get_meeting_links"]);
	});

	it.each([true, false])(
		"runs without a record when the meeting is read-only: %s",
		async (toolsReadOnly) => {
			state.session.toolsReadOnly = toolsReadOnly;
			const result = await createParlumeToolRuntime({
				...context,
				toolsReadOnly,
			}).invoke(chat);

			expect(result).toEqual({ success: true });
			expect(state.actions).toEqual([]);
		},
	);

	it("does not run once the request was interrupted or access changed", async () => {
		state.access = false;

		const result = await createParlumeToolRuntime(context).invoke(chat);

		expect(result).toMatchObject({
			error: expect.stringContaining("Ask again"),
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it("does not open the same exemption to a tool from a connection", async () => {
		state.session.toolsReadOnly = true;

		const result = await createParlumeToolRuntime({
			...context,
			toolsReadOnly: true,
		}).invoke({
			...chat,
			name: "post_message",
			source: { configId: "connection-b", originalName: "post_message" },
		});

		expect(result).toMatchObject({
			error: expect.stringContaining("every project member can read"),
		});
		expect(execute).not.toHaveBeenCalled();
	});
});

// A meeting turn's ceiling is plain project read, whoever is in the meeting.
describe("Parlume's project-read ceiling in a meeting", () => {
	const read = (configId: string, originalName: string) =>
		call({
			name: originalName,
			source: { configId, originalName, access: "READ" },
			args: {},
		});

	it.each([
		["fabric-platform", "fabric_get_feature"],
		["builtin", "project_rag_query"],
		["parlume", "post_to_meeting_chat"],
	])("reads the project with %s's %s", async (configId, name) => {
		await createParlumeToolRuntime(context).invoke(read(configId, name));

		expect(execute).toHaveBeenCalled();
	});

	it.each([
		["fabric-platform", "fabric_list_workflows"],
		["builtin", "fabric_web_search"],
		["builtin", "workspace_rag_query"],
		["connection-b", "list_issues"],
		["databricks-vector-search:integration-1", "search_databricks_indexes"],
	])("leaves out %s's %s, past project read", async (configId, name) => {
		const result = await createParlumeToolRuntime(context).invoke(
			read(configId, name),
		);

		expect(result).toMatchObject({
			error: expect.stringContaining("every project member can read"),
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it("still proposes a change to the project", async () => {
		const result = await createParlumeToolRuntime(context).invoke(call());

		expect(result).toMatchObject({ proposed: true, changed: false });
		expect(execute).not.toHaveBeenCalled();
	});
});
