/**
 * Unlinking a monitored Teams chat removes its pointer row (Fizzy #2228, U7).
 *
 * Chats are NOT a source of conversation capture — capture is scoped to shared
 * channels by decision, because a project is a wider audience than a private
 * conversation — so this procedure reliably finds no bundles to delete. It runs
 * the same deletion path anyway, for the pointer row: a `ProjectContext` left
 * behind keeps an unlinked chat listed as a project context, and a row that has
 * been embedded by some other route keeps its vectors.
 *
 * This is also the first test in this directory; there was none before.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		projectFindFirst: vi.fn(),
		linkedFindFirst: vi.fn(),
		unlinkTeamsChatFromProject: vi.fn(),
		deleteMonitoredConversationContext: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	db: {
		project: { findFirst: mocks.projectFindFirst },
		projectLinkedTeamsChat: { findFirst: mocks.linkedFindFirst },
	},
	unlinkTeamsChatFromProject: (...a: unknown[]) =>
		mocks.unlinkTeamsChatFromProject(...a),
}));

vi.mock("@repo/temporal/delete-channel-context", () => ({
	deleteMonitoredConversationContext: (...a: unknown[]) =>
		mocks.deleteMonitoredConversationContext(...a),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.unlink = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_UPDATE: "project:update" },
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

await import("../unlink-chat");

const ctx = {
	user: { id: "user-1", name: "Ada", email: "ada@example.com" },
	session: {},
};

const input = {
	projectId: "project-1",
	organizationId: "org-1",
	linkedChatId: "linked-chat-1",
};

function unlink(overrides: Record<string, unknown> = {}) {
	return handlers.unlink({ input: { ...input, ...overrides }, context: ctx });
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
	}
	mocks.projectFindFirst.mockResolvedValue({ id: "project-1" });
	mocks.linkedFindFirst.mockResolvedValue({ chatId: "19:chat@thread.v2" });
	mocks.deleteMonitoredConversationContext.mockResolvedValue({
		contextIds: ["ctx-chat-1"],
		bundleIds: [],
	});
	mocks.unlinkTeamsChatFromProject.mockResolvedValue(undefined);
});

describe("unlinkChatProcedure — the pointer row goes with the chat", () => {
	it("routes the chat id through the deletion path as a chat, not a channel", async () => {
		await expect(unlink()).resolves.toEqual({ success: true });

		expect(
			mocks.deleteMonitoredConversationContext,
		).toHaveBeenCalledExactlyOnceWith({
			projectId: "project-1",
			// Passed for the stranded-vector cleanup queue's tenant XOR: an
			// organization unlink keys on `organizationId`, a personal one on
			// this.
			userId: "user-1",
			organizationId: "org-1",
			conversation: {
				provider: "MICROSOFT_TEAMS",
				// `kind: "chat"` selects the `chatId` predicate. A chat routed
				// as a channel would match nothing and leave the row behind.
				kind: "chat",
				chatId: "19:chat@thread.v2",
			},
		});
		expect(mocks.unlinkTeamsChatFromProject).toHaveBeenCalledWith(
			"project-1",
			"linked-chat-1",
		);
	});

	it("deletes the context BEFORE the monitor row it read the identity from", async () => {
		const order: string[] = [];
		mocks.deleteMonitoredConversationContext.mockImplementation(
			async () => {
				order.push("context");
				return { contextIds: ["ctx-chat-1"], bundleIds: [] };
			},
		);
		mocks.unlinkTeamsChatFromProject.mockImplementation(async () => {
			order.push("monitor-row");
		});

		await unlink();

		expect(order).toEqual(["context", "monitor-row"]);
	});

	it("fails the unlink when the deletion path reports a vector-store failure", async () => {
		mocks.deleteMonitoredConversationContext.mockRejectedValue(
			new Error("connection refused"),
		);

		await expect(unlink()).rejects.toThrow("connection refused");
		expect(mocks.unlinkTeamsChatFromProject).not.toHaveBeenCalled();
	});

	it("still removes the monitor row when the chat had no context row", async () => {
		mocks.deleteMonitoredConversationContext.mockResolvedValue({
			contextIds: [],
			bundleIds: [],
		});

		await expect(unlink()).resolves.toEqual({ success: true });
		expect(mocks.unlinkTeamsChatFromProject).toHaveBeenCalledWith(
			"project-1",
			"linked-chat-1",
		);
	});

	it("skips the context deletion when the monitor row is gone — there is no identity to match on", async () => {
		mocks.linkedFindFirst.mockResolvedValue(null);

		await unlink();

		expect(mocks.deleteMonitoredConversationContext).not.toHaveBeenCalled();
	});
});

describe("unlinkChatProcedure — tenant isolation", () => {
	it("scopes the project lookup to the organization", async () => {
		await unlink();

		expect(mocks.projectFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "project-1", organizationId: "org-1" },
			}),
		);
	});

	it("scopes the project lookup to the caller in a personal project", async () => {
		await unlink({ organizationId: null });

		expect(mocks.projectFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "project-1",
					organizationId: null,
					userId: "user-1",
				},
			}),
		);
	});

	it("refuses a project outside the caller's tenant without deleting anything", async () => {
		mocks.projectFindFirst.mockResolvedValue(null);

		await expect(unlink()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.linkedFindFirst).not.toHaveBeenCalled();
		expect(mocks.deleteMonitoredConversationContext).not.toHaveBeenCalled();
		expect(mocks.unlinkTeamsChatFromProject).not.toHaveBeenCalled();
	});

	it("scopes the monitor-row lookup to the project", async () => {
		await unlink();

		expect(mocks.linkedFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "linked-chat-1", projectId: "project-1" },
			}),
		);
	});
});
