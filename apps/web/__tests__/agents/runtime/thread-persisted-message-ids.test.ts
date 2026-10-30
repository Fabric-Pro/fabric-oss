// @vitest-environment node
/**
 * `readThreadPersistedMessageIds` (`runtime/thread.ts`): the message ids saved
 * under a thread, for the durable engine's "already saved?" check on connect.
 *
 *   - the thread's own conversation, then the conversations continuing it
 *     (`parentConversationId`), generation by generation: after a spill at
 *     the turn cap the page saves into the continuation under the same
 *     thread id;
 *   - every continuation read is filtered to the caller's user and
 *     organization;
 *   - a thread that is not the caller's reads nothing further;
 *   - the walk stops after five generations.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getAgentConversationById: vi.fn(),
	findMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	createAgentConversation: vi.fn(),
	getAgentConversationById: h.getAgentConversationById,
	db: { agentConversation: { findMany: h.findMany, findUnique: vi.fn() } },
}));

vi.mock("@repo/api/orpc/procedures", () => ({
	authorizeInputOrganization: vi.fn(),
	Permissions: { AGENT_CREATE: "agent:create", AGENT_UPDATE: "agent:update" },
}));

const { readThreadPersistedMessageIds } = await import(
	"@saas/agents/runtime/thread"
);

const THREAD = "thread-example-0001";
const caller = { userId: "user-example-1", organizationId: "org-example-1" };

interface Row {
	id: string;
	parentConversationId: string;
	messages: Array<{ id: string }>;
}

/** Continuation rows the fake `findMany` answers from, by parent id. */
let rows: Row[] = [];

beforeEach(() => {
	rows = [];
	h.getAgentConversationById.mockReset().mockResolvedValue({
		id: THREAD,
		messages: [{ id: "turn-1" }, { id: "answer-1" }],
	});
	h.findMany
		.mockReset()
		.mockImplementation(
			async (args: {
				where: { parentConversationId: { in: string[] } };
			}) =>
				rows.filter((row) =>
					args.where.parentConversationId.in.includes(
						row.parentConversationId,
					),
				),
		);
});

describe("readThreadPersistedMessageIds", () => {
	it("collects the thread's messages and those of its continuations after a spill", async () => {
		rows = [
			{
				id: "conv-continuation-1",
				parentConversationId: THREAD,
				messages: [{ id: "turn-201" }, { id: "answer-201" }],
			},
			{
				id: "conv-continuation-2",
				parentConversationId: "conv-continuation-1",
				messages: [{ id: "answer-401" }],
			},
		];

		const ids = await readThreadPersistedMessageIds(THREAD, caller);

		expect(ids).toEqual(
			new Set([
				"turn-1",
				"answer-1",
				"turn-201",
				"answer-201",
				"answer-401",
			]),
		);
		expect(h.getAgentConversationById).toHaveBeenCalledWith({
			id: THREAD,
			...caller,
		});
	});

	it("reads continuations only for the caller's user and organization", async () => {
		await readThreadPersistedMessageIds(THREAD, caller);

		expect(h.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					parentConversationId: { in: [THREAD] },
					userId: "user-example-1",
					organizationId: "org-example-1",
				},
			}),
		);
	});

	it("reads nothing further for a thread that is not the caller's", async () => {
		h.getAgentConversationById.mockResolvedValue(null);

		await expect(
			readThreadPersistedMessageIds(THREAD, caller),
		).resolves.toEqual(new Set());
		expect(h.findMany).not.toHaveBeenCalled();
	});

	it("stops after five generations of continuations", async () => {
		let parent = THREAD;
		for (let generation = 1; generation <= 7; generation++) {
			const id = `conv-generation-${generation}`;
			rows.push({
				id,
				parentConversationId: parent,
				messages: [{ id: `answer-generation-${generation}` }],
			});
			parent = id;
		}

		const ids = await readThreadPersistedMessageIds(THREAD, caller);

		expect(h.findMany).toHaveBeenCalledTimes(5);
		expect(ids.has("answer-generation-5")).toBe(true);
		expect(ids.has("answer-generation-6")).toBe(false);
	});
});
