/**
 * Tests for `retryPmSyncBatch` `unlinkFirst` bulk Re-push.
 *
 * With `unlinkFirst: true`, each FLAG_MISSING item must sever its dead PM link
 * (`applyPmUnlink`), dismiss the pending FLAG_MISSING row, and enqueue a forced
 * initial push. The batch stays best-effort — one item throwing (e.g.
 * `applyPmUnlink` rejecting) leaves its siblings enqueued (`Promise.allSettled`:
 * the rejected entry → `enqueued: false`; siblings → `enqueued: true`).
 *
 * Single-item `retryPmSync` and `retryPmSyncBatch` share one helper, so the
 * bulk path inherits the BUG-retry/itemType fix with no logic divergence.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		userStoryFindFirst: vi.fn(),
		userStoryFindMany: vi.fn(),
		userStoryUpdate: vi.fn(),
		projectFindUnique: vi.fn(),
		mcpServerFindUnique: vi.fn(),
		workflowStart: vi.fn(),
		resolvePMConfigForUser: vi.fn(),
		applyPmUnlink: vi.fn(),
		pendingUpdateMany: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	applyPmUnlink: mocks.applyPmUnlink,
	isPmServerIdKeySentinel: (id: string) =>
		typeof id === "string" && id.startsWith("key:"),
	readPmServerIdKeySentinel: (id: string) =>
		typeof id === "string" && id.startsWith("key:") ? id.slice(4) : id,
	db: {
		userStory: {
			findFirst: mocks.userStoryFindFirst,
			findMany: mocks.userStoryFindMany,
			update: mocks.userStoryUpdate,
		},
		project: { findUnique: mocks.projectFindUnique },
		mCPServer: { findUnique: mocks.mcpServerFindUnique },
		pendingPmStateChange: { updateMany: mocks.pendingUpdateMany },
	},
	PmSyncStatus: {
		PENDING: "PENDING",
		SUCCESS: "SUCCESS",
		CONFLICT: "CONFLICT",
		FAILED: "FAILED",
	},
	resolvePMConfigForUser: mocks.resolvePMConfigForUser,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: mocks.workflowStart },
	})),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["retryPmSyncBatch"];
	let cursor = 0;
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			const key = importedHandlerKeys[cursor++] ?? `proc-${cursor}`;
			handlers[key] = fn;
			return { _handler: fn };
		},
	});

	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null) =>
			organizationId,
	};
});

await import("../retry-pm-sync-batch");

const ctx = { user: { id: "user-1" }, session: {} };

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	mocks.resolvePMConfigForUser.mockImplementation(
		async ({ configId }: { configId: string | null }) =>
			configId ? { id: configId, enabled: true } : null,
	);
	mocks.mcpServerFindUnique.mockResolvedValue(null);
	mocks.applyPmUnlink.mockResolvedValue({ applied: true });
	mocks.pendingUpdateMany.mockResolvedValue({ count: 1 });
	mocks.userStoryUpdate.mockResolvedValue({});
	mocks.projectFindUnique.mockResolvedValue({
		id: "project-1",
		organizationId: null,
		projectManagementMcpConfigId: "mcp-1",
		projectManagementContainerId: "container-1",
		projectManagementContainerName: null,
		projectManagementAdditionalContext: null,
	});
	// `enqueuePmSync`'s inner lookup runs after the unlink, so each story is
	// unlinked (externalId: null) here — `forceInitialPush` lets it proceed.
	mocks.userStoryFindFirst.mockResolvedValue({
		id: "story-x",
		externalId: null,
	});
	mocks.workflowStart.mockResolvedValue({ workflowId: "wf-recreate" });
});

describe("retryPmSyncBatchProcedure — unlinkFirst (bulk Re-push)", () => {
	it("severs the dead link, dismisses the FLAG_MISSING row, and forces an initial push per item", async () => {
		mocks.userStoryFindMany.mockResolvedValue([
			{
				id: "story-1",
				externalId: "EXT-1",
				externalMcpServerId: "srv-1",
			},
			{
				id: "story-2",
				externalId: "EXT-2",
				externalMcpServerId: "srv-2",
			},
		]);

		const result = (await handlers.retryPmSyncBatch({
			input: {
				projectId: "project-1",
				items: [
					{ id: "story-1", itemType: "story" as const },
					{ id: "story-2", itemType: "bug" as const },
				],
				unlinkFirst: true,
				organizationId: null,
			},
			context: ctx,
		})) as {
			enqueuedCount: number;
			results: Array<{ id: string; enqueued: boolean }>;
		};

		// Each item severs its dead link with the row's stored provenance.
		expect(mocks.applyPmUnlink).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-1",
				entityType: "STORY",
				entityId: "story-1",
				expectedExternalId: "EXT-1",
				expectedExternalMcpServerId: "srv-1",
			}),
		);
		expect(mocks.applyPmUnlink).toHaveBeenCalledWith(
			expect.objectContaining({
				entityId: "story-2",
				expectedExternalId: "EXT-2",
				expectedExternalMcpServerId: "srv-2",
			}),
		);
		// Each item dismisses its now-stale FLAG_MISSING proposal.
		expect(mocks.pendingUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					entityType: "STORY",
					entityId: "story-1",
					status: "PENDING",
					proposedAction: "FLAG_MISSING",
				}),
				data: { status: "DISMISSED" },
			}),
		);
		// And both re-enqueue (forceInitialPush bypassed the no-external-id guard).
		expect(result.enqueuedCount).toBe(2);
		expect(mocks.workflowStart).toHaveBeenCalledTimes(2);
	});

	it("is best-effort: one item's unlink throwing leaves its siblings enqueued", async () => {
		mocks.userStoryFindMany.mockResolvedValue([
			{
				id: "story-1",
				externalId: "EXT-1",
				externalMcpServerId: "srv-1",
			},
			{
				id: "story-2",
				externalId: "EXT-2",
				externalMcpServerId: "srv-2",
			},
			{
				id: "story-3",
				externalId: "EXT-3",
				externalMcpServerId: "srv-3",
			},
		]);
		// `enqueuePmSync` swallows its own errors, so the only way to produce a
		// rejected `Promise.allSettled` entry is for the unlink to throw.
		mocks.applyPmUnlink.mockImplementation(
			async ({ entityId }: { entityId: string }) => {
				if (entityId === "story-2") {
					throw new Error("unlink failed");
				}
				return { applied: true };
			},
		);

		const result = (await handlers.retryPmSyncBatch({
			input: {
				projectId: "project-1",
				items: [
					{ id: "story-1", itemType: "story" as const },
					{ id: "story-2", itemType: "story" as const },
					{ id: "story-3", itemType: "story" as const },
				],
				unlinkFirst: true,
				organizationId: null,
			},
			context: ctx,
		})) as {
			enqueuedCount: number;
			results: Array<{ id: string; enqueued: boolean }>;
		};

		const byId = new Map(result.results.map((r) => [r.id, r]));
		expect(byId.get("story-1")?.enqueued).toBe(true);
		expect(byId.get("story-2")?.enqueued).toBe(false);
		expect(byId.get("story-3")?.enqueued).toBe(true);
		expect(result.enqueuedCount).toBe(2);
	});

	it("does not unlink when unlinkFirst is false (plain bulk retry)", async () => {
		mocks.userStoryFindMany.mockResolvedValue([
			{
				id: "story-1",
				externalId: "EXT-1",
				externalMcpServerId: "srv-1",
			},
		]);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
		});

		const result = (await handlers.retryPmSyncBatch({
			input: {
				projectId: "project-1",
				items: [{ id: "story-1", itemType: "story" as const }],
				organizationId: null,
			},
			context: ctx,
		})) as { enqueuedCount: number };

		expect(mocks.applyPmUnlink).not.toHaveBeenCalled();
		expect(mocks.pendingUpdateMany).not.toHaveBeenCalled();
		expect(result.enqueuedCount).toBe(1);
	});

	it("retries a failed FIRST push (no externalId) by forcing the initial create — plain retry, no unlinkFirst", async () => {
		// A failed first push never got a card in the PM tool, so the row has no
		// externalId. Without arming the initial push, `enqueuePmSync`
		// short-circuits on `no-external-id` and the Retry button is a silent
		// no-op — the item stays FAILED with the same stale error. The retry of a
		// never-created item must take the CREATE path.
		mocks.userStoryFindMany.mockResolvedValue([
			{ id: "story-1", externalId: null, externalMcpServerId: null },
		]);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: null,
		});

		const result = (await handlers.retryPmSyncBatch({
			input: {
				projectId: "project-1",
				items: [{ id: "story-1", itemType: "story" as const }],
				organizationId: null,
			},
			context: ctx,
		})) as { enqueuedCount: number };

		// No unlink (nothing linked), but the push is still enqueued via the
		// forced initial-create path rather than no-op'd.
		expect(mocks.applyPmUnlink).not.toHaveBeenCalled();
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		expect(result.enqueuedCount).toBe(1);
	});
});
