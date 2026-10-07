/**
 * `saveTurn` and `updateSettings` — authorization and tenant scoping
 * (Fizzy #2949).
 *
 * The Advisor saves each finished turn, and each settings change, through
 * these instead of rewriting the whole conversation with `update`. Like
 * `removeMessage`, they must act only in an organization the caller belongs
 * to AND holds `AGENT_UPDATE` in — judged in the organization the request
 * names, not the session's — and never without an organization filter.
 *
 * These tests drive the REAL authorization: each procedure's own middleware
 * stack and the real `resolveOrganizationId`. Only the procedure builder is
 * replaced, so the test can run the mounted middlewares and then the
 * handler, and only the database edges are mocked.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<unknown>;
type Middleware = (
	options: { context: Record<string, unknown>; next: () => Promise<unknown> },
	input: unknown,
) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
	saveConversationTurn: vi.fn(),
	updateConversationSettings: vi.fn(),
	getOrganizationMembership: vi.fn(),
	procedures: new Map<string, { middlewares: unknown[]; handler: Handler }>(),
	current: [] as unknown[],
	path: "",
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	saveConversationTurn: mocks.saveConversationTurn,
	updateConversationSettings: mocks.updateConversationSettings,
	getOrganizationMembership: mocks.getOrganizationMembership,
}));

// Mocked over the same roles so a build of the procedure that checks only
// membership here is judged on the same data.
vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async (
		organizationId: string,
		userId: string,
	) => await mocks.getOrganizationMembership(organizationId, userId),
}));

vi.mock("../../../../../orpc/procedures", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../../../orpc/procedures")>();
	// Each procedure built from this builder (including the ones in
	// update-conversation.ts, which save-turn.ts imports its message schema
	// from) records its middlewares and handler under its route path.
	const builder: Record<string, unknown> = {};
	Object.assign(builder, {
		use: (mw: unknown) => {
			mocks.current.push(mw);
			return builder;
		},
		route: (route: { path: string }) => {
			mocks.path = route.path;
			return builder;
		},
		input: () => builder,
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

const {
	ConversationNotFoundError,
	DuplicateTurnMessageIdError,
	TurnMessageIdConflictError,
} = await import("@repo/database");
await import("../save-turn");

const USER_ID = "user-1";
const ACTIVE_ORG = "org-active";
const OTHER_ORG = "org-other";
const SAVE_TURN = "/agents/conversations/{conversationId}/turns";
const UPDATE_SETTINGS = "/agents/conversations/{conversationId}/settings";

/** Runs a procedure's mounted middlewares, then its handler. */
async function invoke(
	path: string,
	input: Record<string, unknown>,
): Promise<unknown> {
	const procedure = mocks.procedures.get(path);
	if (!procedure) {
		throw new Error(`no procedure was built for ${path}`);
	}
	const { handler, middlewares } = procedure;
	const context = {
		user: { id: USER_ID, email: "dev@example.com", name: "Dev" },
		session: { id: "sess-1", activeOrganizationId: ACTIVE_ORG },
		// What the tenant middleware sets from the session: the caller's role
		// in the ACTIVE organization, which grants AGENT_UPDATE.
		activeOrganizationRole: "member",
		tenantContext: {
			userId: USER_ID,
			type: "organization",
			organizationId: ACTIVE_ORG,
		},
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

/** The caller's role in each organization; absent means not a member. */
function rolesByOrganization(roles: Record<string, string>) {
	mocks.getOrganizationMembership.mockImplementation(
		async (organizationId: string, userId: string) =>
			userId === USER_ID && roles[organizationId]
				? {
						role: roles[organizationId],
						organization: { deletedAt: null },
					}
				: null,
	);
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

const turnInput = {
	conversationId: "conv-1",
	messages: [
		{
			id: "q-1",
			role: "user",
			content: "What changed?",
			timestamp: "2026-10-06T10:00:00.000Z",
		},
		{
			id: "a-1",
			role: "assistant",
			content: "Three merges.",
			timestamp: "2026-10-06T10:00:05.000Z",
			reasoningText: "private chain of thought",
			reasoningDurationMs: 12,
		},
	],
	execution: { id: "orch-exec-1", status: "complete" },
	removeMessageIds: ["seed-1"],
	settings: { selectedMcpConfigIds: ["mcp_1"] },
};

beforeEach(() => {
	mocks.saveConversationTurn.mockReset();
	mocks.updateConversationSettings.mockReset();
	mocks.getOrganizationMembership.mockReset();
	mocks.saveConversationTurn.mockResolvedValue({
		addedMessages: 2,
		removedMessages: 1,
	});
	mocks.updateConversationSettings.mockResolvedValue({ updated: true });
	rolesByOrganization({ [ACTIVE_ORG]: "member" });
	delete process.env.FABRIC_PERSIST_REASONING_TRACE;
});

describe("saveTurn — authorized in the named organization", () => {
	it("saves the turn in the caller's own conversation, without the reasoning trace", async () => {
		const result = await invoke(SAVE_TURN, {
			...turnInput,
			organizationId: ACTIVE_ORG,
		});

		expect(result).toEqual({
			id: "conv-1",
			addedMessages: 2,
			removedMessages: 1,
		});
		expect(mocks.saveConversationTurn).toHaveBeenCalledWith({
			id: "conv-1",
			userId: USER_ID,
			organizationId: ACTIVE_ORG,
			messages: [
				turnInput.messages[0],
				{
					id: "a-1",
					role: "assistant",
					content: "Three merges.",
					timestamp: "2026-10-06T10:00:05.000Z",
				},
			],
			execution: turnInput.execution,
			removeMessageIds: ["seed-1"],
			settings: { selectedMcpConfigIds: ["mcp_1"] },
		});
	});

	it("uses the session's organization when the request names none", async () => {
		await invoke(SAVE_TURN, turnInput);

		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			ACTIVE_ORG,
			USER_ID,
		);
		expect(mocks.saveConversationTurn).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ACTIVE_ORG }),
		);
	});

	it("refuses an explicit null organization instead of saving without a tenant filter", async () => {
		const error = await refusal(
			invoke(SAVE_TURN, { ...turnInput, organizationId: null }),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.saveConversationTurn).not.toHaveBeenCalled();
	});

	it("refuses an organization the caller is not a member of", async () => {
		const error = await refusal(
			invoke(SAVE_TURN, { ...turnInput, organizationId: OTHER_ORG }),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(error.message).toBe("You are not a member of this organization");
		expect(mocks.saveConversationTurn).not.toHaveBeenCalled();
	});

	it("refuses in an organization where the caller's role lacks AGENT_UPDATE, though the active one grants it", async () => {
		rolesByOrganization({ [ACTIVE_ORG]: "member", [OTHER_ORG]: "viewer" });

		const error = await refusal(
			invoke(SAVE_TURN, { ...turnInput, organizationId: OTHER_ORG }),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.saveConversationTurn).not.toHaveBeenCalled();
	});
});

describe("saveTurn — not found", () => {
	// The database refuses a conversation outside the caller's tenant, and an
	// execution id naming a turn in another conversation, with
	// ConversationNotFoundError (pinned in save-conversation-turn.test.ts).
	it("maps a turn that belongs to another conversation to a generic NOT_FOUND", async () => {
		mocks.saveConversationTurn.mockRejectedValueOnce(
			new ConversationNotFoundError(),
		);

		const error = await refusal(
			invoke(SAVE_TURN, {
				...turnInput,
				execution: { id: "orch-exec-of-another-conversation" },
				organizationId: ACTIVE_ORG,
			}),
		);

		expect(error.code).toBe("NOT_FOUND");
		expect(error.message).toBe("Conversation not found");
	});

	it("maps turn messages that repeat an id to BAD_REQUEST", async () => {
		mocks.saveConversationTurn.mockRejectedValueOnce(
			new DuplicateTurnMessageIdError("same"),
		);

		const error = await refusal(
			invoke(SAVE_TURN, { ...turnInput, organizationId: ACTIVE_ORG }),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.message).toBe("Each message in a turn needs its own id");
	});

	it("maps a message id that belongs to another message to CONFLICT", async () => {
		mocks.saveConversationTurn.mockRejectedValueOnce(
			new TurnMessageIdConflictError("q-1"),
		);

		const error = await refusal(
			invoke(SAVE_TURN, { ...turnInput, organizationId: ACTIVE_ORG }),
		);

		expect(error.code).toBe("CONFLICT");
		expect(error.message).toBe(
			"A message id in this turn already belongs to another message in the conversation",
		);
	});

	it("does not disguise any other failure as NOT_FOUND", async () => {
		mocks.saveConversationTurn.mockRejectedValueOnce(
			new Error("could not serialize access"),
		);

		const error = await invoke(SAVE_TURN, {
			...turnInput,
			organizationId: ACTIVE_ORG,
		}).catch((e: unknown) => e);

		expect(error).not.toBeInstanceOf(ORPCError);
		expect((error as Error).message).toBe("could not serialize access");
	});
});

describe("updateSettings", () => {
	const settingsInput = {
		conversationId: "conv-1",
		settings: { executionMode: "deep", selectedMcpConfigIds: null },
	};

	it("merges the settings in the caller's own conversation", async () => {
		const result = await invoke(UPDATE_SETTINGS, {
			...settingsInput,
			organizationId: ACTIVE_ORG,
		});

		expect(result).toEqual({ id: "conv-1" });
		expect(mocks.updateConversationSettings).toHaveBeenCalledWith({
			id: "conv-1",
			userId: USER_ID,
			organizationId: ACTIVE_ORG,
			settings: { executionMode: "deep", selectedMcpConfigIds: null },
		});
	});

	it("refuses an explicit null organization", async () => {
		const error = await refusal(
			invoke(UPDATE_SETTINGS, { ...settingsInput, organizationId: null }),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.updateConversationSettings).not.toHaveBeenCalled();
	});

	it("refuses an organization the caller is not a member of", async () => {
		const error = await refusal(
			invoke(UPDATE_SETTINGS, {
				...settingsInput,
				organizationId: OTHER_ORG,
			}),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.updateConversationSettings).not.toHaveBeenCalled();
	});

	it("maps ConversationNotFoundError to NOT_FOUND", async () => {
		mocks.updateConversationSettings.mockRejectedValueOnce(
			new ConversationNotFoundError(),
		);

		const error = await refusal(
			invoke(UPDATE_SETTINGS, {
				...settingsInput,
				organizationId: ACTIVE_ORG,
			}),
		);

		expect(error.code).toBe("NOT_FOUND");
	});
});
