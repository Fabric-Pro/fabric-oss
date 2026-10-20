import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parlumeActionOutcome } from "../parlume-action-policy";
import {
	createParlumeToolRuntime,
	type ParlumeActionContext,
} from "../parlume-actions";
import {
	type AgentToolInvocation,
	hasExactAgentToolApproval,
} from "../shared/agent-tool-runtime";

const state = vi.hoisted(() => {
	const initial: {
		session: Record<string, unknown>;
		actions: Array<Record<string, unknown>>;
		access: boolean;
		generationCurrent: boolean;
		audit: ReturnType<typeof vi.fn>;
	} = {
		session: {},
		actions: [],
		access: true,
		generationCurrent: true,
		audit: vi.fn(),
	};
	return initial;
});
vi.mock("../parlume-voice", () => ({
	verifyParlumeVoiceGeneration: vi.fn(async () => state.generationCurrent),
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
	const delegates = { parlumeMeetingSession: session, parlumeAction: action };
	return {
		db: {
			...delegates,
			$transaction: (run: (tx: typeof delegates) => Promise<unknown>) =>
				run(delegates),
		},
		hasProjectAccess: vi.fn(async () => state.access),
		canEditProject: vi.fn(async () => state.access),
		recordAuditTx: state.audit,
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
	agentRevision: "revision",
	voiceGeneration: 3,
	toolsReadOnly: false,
};
const inputSchema = z.object({
	title: z.string(),
	nested: z.object({ value: z.number() }).optional(),
});
const execute = vi.fn(async (): Promise<unknown> => ({ success: true }));

function call(
	overrides: Partial<AgentToolInvocation> & { args?: unknown } = {},
): AgentToolInvocation {
	return {
		name: "connection_b_create_ticket",
		description: "Create a ticket",
		inputSchema,
		source: { configId: "connection-b", originalName: "create_ticket" },
		args: { title: "Review" },
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
	state.generationCurrent = true;
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

describe("Parlume actions without confirmation", () => {
	it("runs a write at once, as the inviter, and records who asked and what came of it", async () => {
		const result = await createParlumeToolRuntime(context).invoke(call());

		expect(result).toEqual({ success: true });
		expect(execute).toHaveBeenCalledTimes(1);
		expect(actionRow()).toMatchObject({
			sessionId: "session",
			projectId: "project",
			userId: "user",
			speakerId: "speaker-a",
			speakerName: "Alex",
			toolConfigId: "connection-b",
			toolOriginalName: "create_ticket",
			arguments: { title: "Review" },
			status: "COMPLETED",
			outcome: JSON.stringify({ success: true }),
			completedAt: expect.any(Date),
		});
		expect(actionRow()?.summary).not.toMatch(/confirm|cancel/i);
	});
	it("writes the audit entry for the executed action once", async () => {
		await createParlumeToolRuntime(context).invoke(call());

		expect(state.audit).toHaveBeenCalledTimes(1);
		expect(state.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "project.parlume.action_confirmed",
				actor: { type: "user", userId: "user" },
				organizationId: "org",
				projectId: "project",
				metadata: expect.objectContaining({
					requesterSpeakerId: "speaker-a",
					toolName: "connection_b_create_ticket",
				}),
			}),
		);
	});
	it("runs the write under the exact approval that tool's own gate checks", async () => {
		let approved = false;
		execute.mockImplementation(async () => {
			approved = hasExactAgentToolApproval({
				configId: "connection-b",
				originalName: "create_ticket",
				userId: "user",
				organizationId: "org",
				args: { title: "Review" },
			});
			return { success: true };
		});

		await createParlumeToolRuntime(context).invoke(call());

		expect(approved).toBe(true);
	});
	it("records a speaker Teams could not name instead of refusing the change", async () => {
		await createParlumeToolRuntime({ ...context, speakerId: null }).invoke(
			call(),
		);

		expect(execute).toHaveBeenCalledTimes(1);
		expect(actionRow()).toMatchObject({ speakerId: "unattributed" });
	});
	it("runs one identical call once in a turn, and says so to the second", async () => {
		const runtime = createParlumeToolRuntime(context);

		await runtime.invoke(call());
		const second = await runtime.invoke(call());

		expect(execute).toHaveBeenCalledTimes(1);
		expect(state.actions).toHaveLength(1);
		expect(second).toMatchObject({ alreadyRequested: true });
		expect(state.audit).toHaveBeenCalledTimes(1);
	});
	it("runs two different changes in one turn", async () => {
		const runtime = createParlumeToolRuntime(context);

		await runtime.invoke(call({ args: { title: "First" } }));
		await runtime.invoke(call({ args: { title: "Second" } }));

		expect(execute).toHaveBeenCalledTimes(2);
		expect(state.actions).toHaveLength(2);
	});
	it("records a created work item's result as completed", async () => {
		execute.mockResolvedValue({
			storyId: "story-1",
			identifier: "251",
			title: "Parlume test",
			url: "https://fabric.example/app/example-org/projects/p/stories/story-1",
			aiDrafted: true,
		});

		const result = await createParlumeToolRuntime(context).invoke(call());

		expect(result).toMatchObject({ identifier: "251" });
		expect(actionRow()?.status).toBe("COMPLETED");
	});
	it("records a refusal from the tool as failed", async () => {
		execute.mockResolvedValue({ error: "Permission denied" });

		await createParlumeToolRuntime(context).invoke(call());

		expect(actionRow()?.status).toBe("FAILED");
	});
	it("records an uncertain outcome and never retries it", async () => {
		execute.mockRejectedValueOnce(new Error("Transport disconnected"));
		const runtime = createParlumeToolRuntime(context);

		const first = await runtime.invoke(call());
		await runtime.invoke(call());

		expect(first).toMatchObject({
			error: expect.stringContaining("could not verify"),
		});
		expect(execute).toHaveBeenCalledTimes(1);
		expect(actionRow()?.status).toBe("OUTCOME_UNKNOWN");
	});
	it("does not run a change once the request was interrupted before dispatch", async () => {
		state.generationCurrent = false;

		const result = await createParlumeToolRuntime(context).invoke(call());

		expect(result).toMatchObject({
			error: expect.stringContaining("No change was made"),
		});
		expect(execute).not.toHaveBeenCalled();
		expect(actionRow()?.status).toBe("CANCELLED");
	});
	it("does not run a change when the inviter's access changed", async () => {
		state.access = false;

		const result = await createParlumeToolRuntime(context).invoke(call());

		expect(result).toMatchObject({
			error: expect.stringContaining("Ask again"),
		});
		expect(execute).not.toHaveBeenCalled();
		expect(state.actions).toEqual([]);
	});
	it("refuses a call that carries credentials, without running it", async () => {
		const result = await createParlumeToolRuntime(context).invoke(
			call({ args: { title: "x", apiKey: "example" } }),
		);

		expect(result).toMatchObject({
			error: expect.stringContaining("credentials"),
		});
		expect(execute).not.toHaveBeenCalled();
		expect(state.actions).toEqual([]);
	});
	it("has no proposal or confirmation step to hold a write", async () => {
		const result = await createParlumeToolRuntime(context).invoke(call());

		expect(result).not.toHaveProperty("status", "awaiting_confirmation");
		expect(state.actions.map((row) => row.status)).not.toContain(
			"AWAITING_CONFIRMATION",
		);
		expect(state.actions.map((row) => row.status)).not.toContain(
			"PROPOSED",
		);
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
			call({
				name: "create_ticket",
				source: { configId: "builtin", originalName: "create_ticket" },
				args: { projectId: "other" },
			}),
		);

		expect(result).toMatchObject({
			error: expect.stringContaining("own project"),
		});
		expect(execute).not.toHaveBeenCalled();
	});
	it("classifies a namespaced MCP read by its original tool name", async () => {
		state.session.toolsReadOnly = true;

		await createParlumeToolRuntime({
			...context,
			toolsReadOnly: true,
		}).invoke(
			call({
				name: "connection_b_get_ticket",
				source: {
					configId: "connection-b",
					originalName: "get_ticket",
				},
				args: { id: "ticket" },
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
		).toEqual(["post_to_meeting_chat"]);
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
			error: expect.stringContaining("read-only"),
		});
		expect(execute).not.toHaveBeenCalled();
	});
});
