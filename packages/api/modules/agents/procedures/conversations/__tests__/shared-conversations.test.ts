/**
 * Fabric Agent sessions an owner shares with the organization: `list` (scope,
 * search, cursor), `get` (read-only for anyone but the owner) and
 * `setVisibility` (owner only).
 *
 * What these cases pin is what the procedures add around the database queries:
 * that an organization is required, that the caller is a member of the one the
 * request names, that every query is asked as the caller, and what a client
 * can tell from the answer (`isOwn`, `owner`, `visibility`). Which session a
 * member may read is the queries' own rule, pinned in
 * `packages/database/__tests__/agent-conversation-sharing.test.ts`.
 *
 * Like `save-turn.test.ts`, each procedure runs through its real middleware
 * stack and the real `resolveOrganizationId`; only the procedure builder and
 * the database edges are replaced.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<unknown>;
type InputSchema = {
	safeParse: (input: unknown) => {
		success: boolean;
		data?: Record<string, unknown>;
	};
};
type Middleware = (
	options: { context: Record<string, unknown>; next: () => Promise<unknown> },
	input: unknown,
) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
	listAgentConversationsForViewer: vi.fn(),
	countAgentConversationsForViewer: vi.fn(),
	getAgentConversationForViewer: vi.fn(),
	setAgentConversationVisibility: vi.fn(),
	getOrganizationMembership: vi.fn(),
	procedures: new Map<string, { middlewares: unknown[]; handler: Handler }>(),
	schemas: new Map<string, InputSchema>(),
	current: [] as unknown[],
	path: "",
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	listAgentConversationsForViewer: mocks.listAgentConversationsForViewer,
	countAgentConversationsForViewer: mocks.countAgentConversationsForViewer,
	getAgentConversationForViewer: mocks.getAgentConversationForViewer,
	setAgentConversationVisibility: mocks.setAgentConversationVisibility,
	getOrganizationMembership: mocks.getOrganizationMembership,
}));

vi.mock("../../../../../orpc/procedures", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../../../orpc/procedures")>();
	const builder: Record<string, unknown> = {};
	Object.assign(builder, {
		use: (mw: unknown) => {
			mocks.current.push(mw);
			return builder;
		},
		route: (route: { path: string; method?: string }) => {
			mocks.path = `${route.method ?? "POST"} ${route.path}`;
			return builder;
		},
		input: (schema: InputSchema) => {
			mocks.schemas.set(mocks.path, schema);
			return builder;
		},
		output: () => builder,
		handler: (fn: Handler) => {
			mocks.procedures.set(mocks.path, {
				middlewares: mocks.current,
				handler: fn,
			});
			mocks.current = [];
			return { _handler: fn };
		},
	});
	return { ...actual, tenantProtectedProcedure: builder };
});

const { AgentConversationCursorError, ConversationNotFoundError } =
	await import("@repo/database");
await import("../list-conversations");
await import("../get-conversation");
await import("../set-visibility");

const USER_ID = "user-1";
const ACTIVE_ORG = "org-active";
const OTHER_ORG = "org-other";
const LIST = "GET /agents/conversations";
const GET = "GET /agents/conversations/{id}";
const SET_VISIBILITY = "POST /agents/conversations/{id}/visibility";
const AGENT = "fabric-workspace-assistant";

async function invoke(
	path: string,
	input: Record<string, unknown>,
	options: { activeOrganizationId?: string | null } = {},
): Promise<unknown> {
	const procedure = mocks.procedures.get(path);
	if (!procedure) {
		throw new Error(`no procedure was built for ${path}`);
	}
	const { handler, middlewares } = procedure;
	const activeOrganizationId =
		options.activeOrganizationId === undefined
			? ACTIVE_ORG
			: options.activeOrganizationId;
	const context = {
		user: { id: USER_ID, email: "dev@example.com", name: "Dev" },
		session: { id: "sess-1", activeOrganizationId },
		activeOrganizationRole: "member",
		tenantContext: activeOrganizationId
			? {
					userId: USER_ID,
					type: "organization",
					organizationId: activeOrganizationId,
				}
			: { userId: USER_ID, type: "personal" },
		headers: new Headers(),
	};
	const run = async (index: number): Promise<unknown> => {
		if (index === middlewares.length) {
			return { output: await handler({ input, context }) };
		}
		return await (middlewares[index] as Middleware)(
			{ context, next: () => run(index + 1) },
			input,
		);
	};
	const result = (await run(0)) as { output: unknown };
	return result.output;
}

async function refusal(promise: Promise<unknown>) {
	const error = await promise.then(
		() => {
			throw new Error("expected a refusal");
		},
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ORPCError);
	return error as ORPCError<string, unknown>;
}

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "conv-1",
		userId: USER_ID,
		organizationId: ACTIVE_ORG,
		agentId: AGENT,
		title: "Quarterly plan",
		messages: [
			{
				id: "m1",
				role: "user",
				content: "Plan Q4",
				timestamp: "2026-10-01T10:00:00.000Z",
			},
			{
				id: "m2",
				role: "assistant",
				content: "x".repeat(300),
				timestamp: "2026-10-01T10:00:05.000Z",
			},
		],
		trajectory: null,
		metadata: { mode: "orchestrator" },
		pinned: true,
		status: "ACTIVE",
		visibility: "PRIVATE",
		parentConversationId: null,
		carriedOverSummary: null,
		carriedOverAt: null,
		createdAt: new Date("2026-10-01T10:00:00Z"),
		updatedAt: new Date("2026-10-02T10:00:00Z"),
		...overrides,
	};
}

const OWNER = { id: USER_ID, name: "Dev" };
const OTHER = { id: "user-2", name: "Grace Hopper" };

beforeEach(() => {
	for (const mock of [
		mocks.listAgentConversationsForViewer,
		mocks.countAgentConversationsForViewer,
		mocks.getAgentConversationForViewer,
		mocks.setAgentConversationVisibility,
		mocks.getOrganizationMembership,
	]) {
		mock.mockReset();
	}
	mocks.countAgentConversationsForViewer.mockResolvedValue(0);
	mocks.getOrganizationMembership.mockImplementation(
		async (organizationId: string, userId: string) =>
			userId === USER_ID && organizationId === ACTIVE_ORG
				? { role: "member", organization: { deletedAt: null } }
				: null,
	);
});

describe("agents.conversations.list: what a list item is", () => {
	beforeEach(() => {
		mocks.listAgentConversationsForViewer.mockResolvedValue({
			items: [{ ...row(), isOwn: true, owner: OWNER }],
		});
	});

	it("lists a session with its visibility and who owns it, and without its messages", async () => {
		const result = (await invoke(LIST, {
			agentId: AGENT,
			scope: "mine",
			limit: 50,
		})) as { conversations: Array<Record<string, unknown>> };

		expect(result.conversations).toEqual([
			{
				id: "conv-1",
				agentId: AGENT,
				title: "Quarterly plan",
				messageCount: 2,
				pinned: true,
				status: "ACTIVE",
				visibility: "PRIVATE",
				createdAt: "2026-10-01T10:00:00.000Z",
				updatedAt: "2026-10-02T10:00:00.000Z",
				lastMessage: "x".repeat(100),
				metadata: { mode: "orchestrator" },
				isOwn: true,
				owner: OWNER,
			},
		]);
	});
});

describe("agents.conversations.list: scope, search and cursor paging", () => {
	beforeEach(() => {
		mocks.listAgentConversationsForViewer.mockResolvedValue({
			items: [
				{ ...row(), isOwn: true, owner: OWNER },
				{
					...row({
						id: "conv-2",
						userId: OTHER.id,
						visibility: "ORGANIZATION",
						pinned: true,
					}),
					isOwn: false,
					owner: OTHER,
				},
			],
			nextCursor: "cursor-2",
		});
	});

	it("lists the shared sessions of the organization as the caller, and returns the cursor for the next page", async () => {
		const result = (await invoke(LIST, {
			agentId: AGENT,
			scope: "shared",
			search: "plan",
			status: "ACTIVE",
			cursor: "cursor-1",
			limit: 20,
		})) as {
			conversations: Array<Record<string, unknown>>;
			hasMore: boolean;
			nextCursor?: string;
			total?: number;
		};

		expect(mocks.listAgentConversationsForViewer).toHaveBeenCalledWith({
			userId: USER_ID,
			organizationId: ACTIVE_ORG,
			agentId: AGENT,
			scope: "shared",
			search: "plan",
			status: "ACTIVE",
			cursor: "cursor-1",
			limit: 20,
		});
		expect(result.hasMore).toBe(true);
		expect(result.nextCursor).toBe("cursor-2");
	});

	it("says who owns each session, and shows another member's pin as not pinned", async () => {
		const result = (await invoke(LIST, {
			agentId: AGENT,
			scope: "shared",
			limit: 20,
		})) as { conversations: Array<Record<string, unknown>> };

		expect(result.conversations[0]).toMatchObject({
			id: "conv-1",
			isOwn: true,
			owner: OWNER,
			pinned: true,
		});
		expect(result.conversations[1]).toMatchObject({
			id: "conv-2",
			isOwn: false,
			owner: OTHER,
			visibility: "ORGANIZATION",
			pinned: false,
		});
	});

	it("lists the caller's own sessions for scope mine, newest and pinned first as the query orders them", async () => {
		await invoke(LIST, {
			agentId: AGENT,
			scope: "mine",
			search: "plan",
			limit: 50,
		});

		expect(mocks.listAgentConversationsForViewer).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: USER_ID,
				scope: "mine",
				search: "plan",
			}),
		);
	});

	it("asks for every agent's sessions when no agent is named, as the Execution History does", async () => {
		await invoke(LIST, { scope: "mine", status: "ACTIVE", limit: 100 });
		await invoke(LIST, { scope: "shared", limit: 100 });

		const [mine, shared] = mocks.listAgentConversationsForViewer.mock.calls;
		expect(mine[0]).toMatchObject({
			userId: USER_ID,
			organizationId: ACTIVE_ORG,
			scope: "mine",
			agentId: undefined,
		});
		expect(shared[0]).toMatchObject({
			organizationId: ACTIVE_ORG,
			scope: "shared",
			agentId: undefined,
		});
	});

	it("still asks for one agent's sessions when one is named", async () => {
		await invoke(LIST, { agentId: AGENT, scope: "mine", limit: 50 });

		expect(mocks.listAgentConversationsForViewer).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: AGENT }),
		);
	});

	it("gives no cursor and no more pages at the end of the list", async () => {
		mocks.listAgentConversationsForViewer.mockResolvedValue({ items: [] });

		const result = await invoke(LIST, {
			agentId: AGENT,
			scope: "mine",
			limit: 50,
		});

		expect(result).toEqual({ conversations: [], hasMore: false, total: 0 });
	});

	describe("for the older clients of the public route", () => {
		it("pages by the deprecated offset, and answers the total under the same filter alongside the cursor", async () => {
			mocks.countAgentConversationsForViewer.mockResolvedValue(42);

			const result = (await invoke(LIST, {
				agentId: AGENT,
				scope: "mine",
				status: "ACTIVE",
				offset: 20,
				limit: 10,
			})) as { total: number; hasMore: boolean; nextCursor?: string };

			expect(mocks.listAgentConversationsForViewer).toHaveBeenCalledWith({
				userId: USER_ID,
				organizationId: ACTIVE_ORG,
				agentId: AGENT,
				scope: "mine",
				search: undefined,
				status: "ACTIVE",
				cursor: undefined,
				offset: 20,
				limit: 10,
			});
			expect(mocks.countAgentConversationsForViewer).toHaveBeenCalledWith(
				{
					userId: USER_ID,
					organizationId: ACTIVE_ORG,
					agentId: AGENT,
					scope: "mine",
					search: undefined,
					status: "ACTIVE",
				},
			);
			expect(result.total).toBe(42);
			expect(result.hasMore).toBe(true);
			expect(result.nextCursor).toBe("cursor-2");
		});

		it("refuses an offset sent together with a cursor", async () => {
			const error = await refusal(
				invoke(LIST, {
					agentId: AGENT,
					scope: "mine",
					offset: 20,
					cursor: "cursor-1",
					limit: 10,
				}),
			);

			expect(error.code).toBe("BAD_REQUEST");
			expect(
				mocks.listAgentConversationsForViewer,
			).not.toHaveBeenCalled();
		});

		it("counts a cursor page too, so the total is on every answer", async () => {
			mocks.countAgentConversationsForViewer.mockResolvedValue(7);

			const result = await invoke(LIST, {
				agentId: AGENT,
				scope: "shared",
				cursor: "cursor-1",
				limit: 10,
			});

			expect(result).toMatchObject({ total: 7 });
		});
	});

	it("refuses a cursor it did not issue as a bad request", async () => {
		mocks.listAgentConversationsForViewer.mockRejectedValue(
			new AgentConversationCursorError(),
		);

		const error = await refusal(
			invoke(LIST, {
				agentId: AGENT,
				scope: "mine",
				cursor: "junk",
				limit: 50,
			}),
		);

		expect(error.code).toBe("BAD_REQUEST");
	});

	it("does not disguise another failure as a bad cursor", async () => {
		mocks.listAgentConversationsForViewer.mockRejectedValue(
			new Error("connection reset"),
		);

		await expect(
			invoke(LIST, {
				agentId: AGENT,
				scope: "shared",
				limit: 50,
			}),
		).rejects.toThrow("connection reset");
	});

	it("needs an organization, and asks the database nothing without one", async () => {
		const error = await refusal(
			invoke(
				LIST,
				{ agentId: AGENT, scope: "mine", limit: 50 },
				{ activeOrganizationId: null },
			),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.listAgentConversationsForViewer).not.toHaveBeenCalled();
	});

	it("refuses an organization the caller is not a member of, before any query", async () => {
		const error = await refusal(
			invoke(LIST, {
				agentId: AGENT,
				scope: "shared",
				organizationId: OTHER_ORG,
				limit: 50,
			}),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.listAgentConversationsForViewer).not.toHaveBeenCalled();
	});
});

describe("agents.conversations.list: its input", () => {
	function parse(input: Record<string, unknown>) {
		const schema = mocks.schemas.get(LIST);
		if (!schema) {
			throw new Error(`no input schema was built for ${LIST}`);
		}
		return schema.safeParse(input);
	}

	it("does not need an agent, and lists the caller's own sessions, 50 at a time, by default", () => {
		const parsed = parse({});

		expect(parsed.success).toBe(true);
		expect(parsed.data).toMatchObject({ scope: "mine", limit: 50 });
		expect(parsed.data).not.toHaveProperty("agentId");
	});

	it("takes an agent when one is named, and refuses an empty one", () => {
		expect(parse({ agentId: AGENT }).data).toMatchObject({
			agentId: AGENT,
		});
		expect(parse({ agentId: "" }).success).toBe(false);
	});

	it("still takes the deprecated offset, a whole number from 0", () => {
		expect(parse({ offset: 20 }).data).toMatchObject({ offset: 20 });
		expect(parse({ offset: -1 }).success).toBe(false);
		expect(parse({ offset: 1.5 }).success).toBe(false);
	});

	it("refuses a scope that is neither mine nor shared, and a limit over 100", () => {
		expect(parse({ scope: "everyone" }).success).toBe(false);
		expect(parse({ limit: 101 }).success).toBe(false);
	});
});

/**
 * A session full of things that belong to its owner: what tools returned and
 * were asked, reasoning, files they attached, their settings and connections,
 * the record of each turn, and what they carried over from an earlier chat. A
 * reader of a shared session is shown the words and nothing else.
 */
function richSession(overrides: Record<string, unknown> = {}) {
	return row({
		messages: [
			{
				id: "m1",
				role: "user",
				content: "Plan Q4",
				timestamp: "2026-10-01T10:00:00.000Z",
				metadata: { token: "SECRET-MESSAGE-METADATA" },
				attachments: [
					{
						id: "a1",
						s3Path: "org/SECRET-STORAGE-PATH/plan.pdf",
						name: "plan.pdf",
						mimeType: "application/pdf",
					},
				],
			},
			{
				id: "m2",
				role: "assistant",
				content: "Here is a plan.",
				timestamp: "2026-10-01T10:00:05.000Z",
				agentId: "SECRET-AGENT",
				streamStatus: "completed",
				reasoningText: "SECRET-REASONING",
				reasoningDurationMs: 4200,
				toolCalls: [
					{
						id: "t1",
						name: "crm__get_account",
						args: { query: "SECRET-TOOL-ARGS" },
						result: "SECRET-TOOL-RESULT",
						status: "success",
					},
				],
			},
		],
		metadata: {
			mode: "orchestrator",
			instanceId: "SECRET-INSTANCE",
			selectedMcpConfigIds: ["SECRET-CONNECTION"],
			executions: [{ id: "SECRET-EXECUTION" }],
		},
		trajectory: {
			id: "traj-1",
			nodes: [
				{
					id: "n1",
					type: "tool_call",
					label: "SECRET-TRAJECTORY-LABEL",
					status: "success",
					timestamp: "2026-10-01T10:00:02.000Z",
					children: [],
				},
			],
			edges: [],
			startTime: "2026-10-01T10:00:00.000Z",
			status: "completed",
		},
		parentConversationId: "SECRET-PARENT",
		carriedOverSummary: "SECRET-CARRIED-OVER",
		carriedOverAt: new Date("2026-10-01T09:00:00Z"),
		...overrides,
	});
}

describe("a session another member shared, as its reader is told of it", () => {
	const shared = () => ({
		...richSession({ userId: OTHER.id, visibility: "ORGANIZATION" }),
		isOwn: false,
		owner: OTHER,
	});
	const own = () => ({ ...richSession(), isOwn: true, owner: OWNER });

	it("is the transcript and nothing behind it: role, text and time of each message", async () => {
		mocks.getAgentConversationForViewer.mockResolvedValue(shared());

		const result = (await invoke(GET, { id: "conv-1" })) as {
			messages: unknown[];
		};

		expect(result.messages).toEqual([
			{
				id: "m1",
				role: "user",
				content: "Plan Q4",
				timestamp: "2026-10-01T10:00:00.000Z",
			},
			{
				id: "m2",
				role: "assistant",
				content: "Here is a plan.",
				timestamp: "2026-10-01T10:00:05.000Z",
			},
		]);
	});

	it("carries nothing of the owner's tool calls, reasoning, files, settings, trajectory or earlier chat", async () => {
		mocks.getAgentConversationForViewer.mockResolvedValue(shared());

		const result = await invoke(GET, { id: "conv-1" });

		expect(JSON.stringify(result)).not.toContain("SECRET");
		expect(result).toMatchObject({
			trajectory: null,
			parentConversationId: null,
			carriedOverSummary: null,
			carriedOverAt: null,
			isOwn: false,
		});
	});

	it("keeps only which engine it ran on, which the history list shows", async () => {
		mocks.getAgentConversationForViewer.mockResolvedValue(shared());

		const result = await invoke(GET, { id: "conv-1" });

		expect(result).toMatchObject({ metadata: { mode: "orchestrator" } });
		expect((result as { metadata: object }).metadata).toEqual({
			mode: "orchestrator",
		});
	});

	it("is the same in a list: the engine, and none of the rest of the metadata", async () => {
		mocks.listAgentConversationsForViewer.mockResolvedValue({
			items: [shared()],
		});

		const result = await invoke(LIST, {
			agentId: AGENT,
			scope: "shared",
			limit: 50,
		});

		expect(JSON.stringify(result)).not.toContain("SECRET");
		expect(
			(result as { conversations: Array<{ metadata: unknown }> })
				.conversations[0].metadata,
		).toEqual({ mode: "orchestrator" });
	});

	it("tells nothing of the engine for a session whose metadata names none", async () => {
		mocks.getAgentConversationForViewer.mockResolvedValue({
			...shared(),
			metadata: { instanceId: "SECRET-INSTANCE" },
		});

		const result = await invoke(GET, { id: "conv-1" });

		expect(result).toMatchObject({ metadata: null });
	});

	it("is the full row for the owner of the session", async () => {
		mocks.getAgentConversationForViewer.mockResolvedValue(own());

		const result = (await invoke(GET, { id: "conv-1" })) as {
			messages: Array<Record<string, unknown>>;
			metadata: Record<string, unknown>;
			trajectory: { nodes: unknown[] };
		};

		expect(result.messages[1]).toMatchObject({
			reasoningText: "SECRET-REASONING",
			toolCalls: [
				{ name: "crm__get_account", result: "SECRET-TOOL-RESULT" },
			],
		});
		expect(result.messages[0].attachments).toHaveLength(1);
		expect(result.metadata).toMatchObject({
			instanceId: "SECRET-INSTANCE",
			executions: [{ id: "SECRET-EXECUTION" }],
		});
		expect(result.trajectory.nodes).toHaveLength(1);
		expect(result).toMatchObject({
			parentConversationId: "SECRET-PARENT",
			carriedOverSummary: "SECRET-CARRIED-OVER",
		});
	});

	it("is the full metadata for the owner in a list", async () => {
		mocks.listAgentConversationsForViewer.mockResolvedValue({
			items: [own()],
		});

		const result = (await invoke(LIST, {
			agentId: AGENT,
			scope: "mine",
			limit: 50,
		})) as { conversations: Array<{ metadata: Record<string, unknown> }> };

		expect(result.conversations[0].metadata).toMatchObject({
			instanceId: "SECRET-INSTANCE",
		});
	});
});

describe("agents.conversations.get", () => {
	it("opens the caller's own session, as its owner", async () => {
		mocks.getAgentConversationForViewer.mockResolvedValue({
			...row(),
			isOwn: true,
			owner: OWNER,
		});

		const result = await invoke(GET, { id: "conv-1" });

		expect(mocks.getAgentConversationForViewer).toHaveBeenCalledWith({
			id: "conv-1",
			userId: USER_ID,
			organizationId: ACTIVE_ORG,
		});
		expect(result).toMatchObject({
			id: "conv-1",
			isOwn: true,
			owner: OWNER,
			visibility: "PRIVATE",
			pinned: true,
			messages: row().messages,
		});
	});

	it("opens a session another member shared, and says it is not the caller's", async () => {
		mocks.getAgentConversationForViewer.mockResolvedValue({
			...row({
				userId: OTHER.id,
				visibility: "ORGANIZATION",
				pinned: true,
			}),
			isOwn: false,
			owner: OTHER,
		});

		const result = await invoke(GET, { id: "conv-1" });

		expect(result).toMatchObject({
			isOwn: false,
			owner: OTHER,
			visibility: "ORGANIZATION",
			pinned: false,
		});
	});

	it("answers not found for a session the caller may not read", async () => {
		mocks.getAgentConversationForViewer.mockResolvedValue(null);

		const error = await refusal(invoke(GET, { id: "conv-private" }));

		expect(error.code).toBe("NOT_FOUND");
		expect(error.message).toBe("Conversation not found");
	});

	it("needs an organization, and asks the database nothing without one", async () => {
		const error = await refusal(
			invoke(GET, { id: "conv-1" }, { activeOrganizationId: null }),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.getAgentConversationForViewer).not.toHaveBeenCalled();
	});

	it("refuses an organization the caller is not a member of", async () => {
		const error = await refusal(
			invoke(GET, { id: "conv-1", organizationId: OTHER_ORG }),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.getAgentConversationForViewer).not.toHaveBeenCalled();
	});
});

describe("agents.conversations.setVisibility", () => {
	it("is authorized in the organization the request names: a role without AGENT_UPDATE there is refused, though the active organization grants it", async () => {
		mocks.getOrganizationMembership.mockImplementation(
			async (organizationId: string, userId: string) =>
				userId === USER_ID && organizationId === ACTIVE_ORG
					? { role: "member", organization: { deletedAt: null } }
					: userId === USER_ID && organizationId === OTHER_ORG
						? { role: "viewer", organization: { deletedAt: null } }
						: null,
		);

		const error = await refusal(
			invoke(SET_VISIBILITY, {
				id: "conv-1",
				organizationId: OTHER_ORG,
				visibility: "ORGANIZATION",
			}),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.setAgentConversationVisibility).not.toHaveBeenCalled();
	});

	it("shares the caller's own session with the organization, as the caller", async () => {
		mocks.setAgentConversationVisibility.mockResolvedValue(
			row({ visibility: "ORGANIZATION" }),
		);

		const result = await invoke(SET_VISIBILITY, {
			id: "conv-1",
			visibility: "ORGANIZATION",
		});

		expect(mocks.setAgentConversationVisibility).toHaveBeenCalledWith({
			id: "conv-1",
			userId: USER_ID,
			organizationId: ACTIVE_ORG,
			visibility: "ORGANIZATION",
		});
		expect(result).toEqual({
			id: "conv-1",
			visibility: "ORGANIZATION",
			updatedAt: "2026-10-02T10:00:00.000Z",
		});
	});

	it("takes it back to private", async () => {
		mocks.setAgentConversationVisibility.mockResolvedValue(row());

		const result = await invoke(SET_VISIBILITY, {
			id: "conv-1",
			visibility: "PRIVATE",
		});

		expect(result).toMatchObject({ visibility: "PRIVATE" });
	});

	it("answers not found for a session that is not the caller's, shared or not", async () => {
		mocks.setAgentConversationVisibility.mockRejectedValue(
			new ConversationNotFoundError(),
		);

		const error = await refusal(
			invoke(SET_VISIBILITY, {
				id: "conv-of-another",
				visibility: "PRIVATE",
			}),
		);

		expect(error.code).toBe("NOT_FOUND");
		expect(error.message).toBe("Conversation not found");
	});

	it("does not disguise another failure as not found", async () => {
		mocks.setAgentConversationVisibility.mockRejectedValue(
			new Error("connection reset"),
		);

		await expect(
			invoke(SET_VISIBILITY, { id: "conv-1", visibility: "PRIVATE" }),
		).rejects.toThrow("connection reset");
	});

	it("needs an organization, and changes nothing without one", async () => {
		const error = await refusal(
			invoke(
				SET_VISIBILITY,
				{ id: "conv-1", visibility: "ORGANIZATION" },
				{ activeOrganizationId: null },
			),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.setAgentConversationVisibility).not.toHaveBeenCalled();
	});

	it("refuses an organization the caller is not a member of", async () => {
		const error = await refusal(
			invoke(SET_VISIBILITY, {
				id: "conv-1",
				organizationId: OTHER_ORG,
				visibility: "ORGANIZATION",
			}),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.setAgentConversationVisibility).not.toHaveBeenCalled();
	});
});
