/**
 * Unlinking a monitored Teams channel takes its captured context with it
 * (Fizzy #2228, U7).
 *
 * Before this, unlink removed the monitor row and the seen-message markers and
 * stopped there. The channel's `ProjectContext` pointer row stayed — so an
 * unlinked channel kept appearing as a project context — and every conversation
 * bundle captured under it stayed with it, vectors and all, answering
 * retrieval for a channel the user had removed.
 *
 * What this file pins is the WIRING: that the procedure hands the deletion path
 * the channel's real provider identity, that a vector-store failure surfaces
 * rather than being swallowed into `{ success: true }`, and that the tenant
 * filter is what decides whether any of it runs. The deletion protocol itself —
 * which vectors go, in which collection, and how it interleaves with an
 * in-flight embed — is pinned in
 * `packages/temporal/__tests__/conversation-bundle-capture.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		projectFindFirst: vi.fn(),
		linkedFindFirst: vi.fn(),
		unlinkTeamsChannelFromProject: vi.fn(),
		deleteMonitoredConversationContext: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	db: {
		project: { findFirst: mocks.projectFindFirst },
		projectLinkedTeamsChannel: { findFirst: mocks.linkedFindFirst },
	},
	unlinkTeamsChannelFromProject: (...a: unknown[]) =>
		mocks.unlinkTeamsChannelFromProject(...a),
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
	mocks.linkedFindFirst.mockResolvedValue({
		teamId: "team-guid",
		channelId: "19:channel@thread.tacv2",
	});
	mocks.deleteMonitoredConversationContext.mockResolvedValue({
		contextIds: ["ctx-1"],
		bundleIds: ["bundle-1", "bundle-2"],
	});
	mocks.unlinkTeamsChannelFromProject.mockResolvedValue(undefined);
});

describe("unlinkChannelProcedure — captured context goes with the channel", () => {
	it("routes the channel's provider identity through the deletion path", async () => {
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
				kind: "channel",
				// (teamId, channelId) — the pair the context's metadata is
				// keyed on, read off the monitor row while it still exists.
				teamId: "team-guid",
				channelId: "19:channel@thread.tacv2",
			},
		});
		expect(mocks.unlinkTeamsChannelFromProject).toHaveBeenCalledWith(
			"project-1",
			"linked-1",
		);
	});

	it("deletes the context BEFORE the monitor row it read the identity from", async () => {
		const order: string[] = [];
		mocks.deleteMonitoredConversationContext.mockImplementation(
			async () => {
				order.push("context");
				return { contextIds: ["ctx-1"], bundleIds: [] };
			},
		);
		mocks.unlinkTeamsChannelFromProject.mockImplementation(async () => {
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
		// The channel stays linked, so the user sees a failure they can retry
		// rather than a success that left conversation text searchable.
		expect(mocks.unlinkTeamsChannelFromProject).not.toHaveBeenCalled();
	});

	it("still removes the monitor row when the channel had no context row", async () => {
		mocks.deleteMonitoredConversationContext.mockResolvedValue({
			contextIds: [],
			bundleIds: [],
		});

		await expect(unlink()).resolves.toEqual({ success: true });
		expect(mocks.unlinkTeamsChannelFromProject).toHaveBeenCalledWith(
			"project-1",
			"linked-1",
		);
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
				// `organizationId: null` is required, not incidental: without
				// it a personal lookup would also match org-owned projects.
				where: {
					id: "project-1",
					organizationId: null,
					userId: "user-1",
				},
			}),
		);
		expect(mocks.deleteMonitoredConversationContext).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: undefined }),
		);
	});

	it("refuses a project outside the caller's tenant without deleting anything", async () => {
		mocks.projectFindFirst.mockResolvedValue(null);

		await expect(unlink()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.linkedFindFirst).not.toHaveBeenCalled();
		expect(mocks.deleteMonitoredConversationContext).not.toHaveBeenCalled();
		expect(mocks.unlinkTeamsChannelFromProject).not.toHaveBeenCalled();
	});

	it("scopes the monitor-row lookup to the project", async () => {
		await unlink();

		expect(mocks.linkedFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "linked-1", projectId: "project-1" },
			}),
		);
	});
});
