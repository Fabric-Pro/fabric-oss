/**
 * Unlinking a monitored Slack channel takes its captured context with it
 * (Fizzy #2228, U7).
 *
 * The Slack sibling of the Teams channel test, and it matters more here than
 * symmetry suggests: a Slack channel linked from Project Settings only started
 * getting a `ProjectContext` row in this same change set, so the rows this
 * procedure has to clean up are new, and nothing was ever removing them.
 *
 * Note what the deletion path is handed — `channelId` alone, never the
 * workspace id. The Add-Context writers never persisted one, so a context row
 * created by them would go unrecognized by a `(slackTeamId, channelId)` match
 * and survive the unlink. `slack-integration-context.ts` documents the same
 * asymmetry on the write side.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		projectFindFirst: vi.fn(),
		linkedFindFirst: vi.fn(),
		linkedDeleteMany: vi.fn(),
		deleteMonitoredConversationContext: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	db: {
		project: { findFirst: mocks.projectFindFirst },
		projectLinkedSlackChannel: {
			findFirst: mocks.linkedFindFirst,
			deleteMany: mocks.linkedDeleteMany,
		},
	},
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

await import("../unlink-channel");

const ctx = {
	user: { id: "user-1", name: "Ada", email: "ada@example.com" },
	session: {},
};

const input = {
	projectId: "project-1",
	organizationId: "org-1",
	linkedChannelId: "linked-1",
};

function unlink(overrides: Record<string, unknown> = {}) {
	return handlers.unlink({ input: { ...input, ...overrides }, context: ctx });
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
	}
	mocks.projectFindFirst.mockResolvedValue({ id: "project-1" });
	mocks.linkedFindFirst.mockResolvedValue({ channelId: "C123" });
	mocks.deleteMonitoredConversationContext.mockResolvedValue({
		contextIds: ["ctx-1"],
		bundleIds: ["bundle-1"],
	});
	mocks.linkedDeleteMany.mockResolvedValue({ count: 1 });
});

describe("unlinkChannelProcedure — captured context goes with the channel", () => {
	it("routes the channel id through the deletion path, without the workspace id", async () => {
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
				provider: "SLACK",
				kind: "channel",
				channelId: "C123",
			},
		});
	});

	it("deletes the context BEFORE the monitor row it read the identity from", async () => {
		const order: string[] = [];
		mocks.deleteMonitoredConversationContext.mockImplementation(
			async () => {
				order.push("context");
				return { contextIds: ["ctx-1"], bundleIds: [] };
			},
		);
		mocks.linkedDeleteMany.mockImplementation(async () => {
			order.push("monitor-row");
			return { count: 1 };
		});

		await unlink();

		expect(order).toEqual(["context", "monitor-row"]);
	});

	it("fails the unlink when the deletion path reports a vector-store failure", async () => {
		mocks.deleteMonitoredConversationContext.mockRejectedValue(
			new Error("connection refused"),
		);

		await expect(unlink()).rejects.toThrow("connection refused");
		expect(mocks.linkedDeleteMany).not.toHaveBeenCalled();
	});

	it("still removes the monitor row when the channel had no context row", async () => {
		mocks.deleteMonitoredConversationContext.mockResolvedValue({
			contextIds: [],
			bundleIds: [],
		});

		await expect(unlink()).resolves.toEqual({ success: true });
		expect(mocks.linkedDeleteMany).toHaveBeenCalledWith({
			where: { id: "linked-1", projectId: "project-1" },
		});
	});

	it("skips the context deletion when the monitor row is gone — there is no identity to match on", async () => {
		mocks.linkedFindFirst.mockResolvedValue(null);

		await unlink();

		expect(mocks.deleteMonitoredConversationContext).not.toHaveBeenCalled();
	});
});

describe("unlinkChannelProcedure — tenant isolation", () => {
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
		expect(mocks.linkedDeleteMany).not.toHaveBeenCalled();
	});

	it("scopes the monitor-row lookup to the project, so a guessed id from another project matches nothing", async () => {
		await unlink({ linkedChannelId: "someone-elses-link" });

		expect(mocks.linkedFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "someone-elses-link",
					projectId: "project-1",
				},
			}),
		);
	});
});
