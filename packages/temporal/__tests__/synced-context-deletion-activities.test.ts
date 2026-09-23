/**
 * The activities of `syncedContextDeletionWorkflow` (Fizzy #2636): the
 * compare-and-set delete behind `fabric context push --prune`, and the
 * realtime publish that follows a delete.
 *
 * What this pins:
 *  - each activity carries the project's hosting organization to its query
 *    or to the vector store, never a default;
 *  - the answers are plain JSON (dates as ISO strings), because a Date does
 *    not survive Temporal's payload converter as a Date;
 *  - every activity is safe to repeat, since Temporal retries them:
 *    the claim is a guarded write that matches again; the vector delete is
 *    `deleteProjectContext(..., { strict: true })`, which succeeds on a
 *    context with no points left; the row delete answers from the query's
 *    receipt check — its own committed attempt is `deleted`, somebody
 *    else's delete is `absent` — never from the attempt number, which
 *    cannot prove who deleted the row;
 *  - the row delete hands the query the operation id, the claimed title and
 *    the request's audit context, so the audit row commits with the delete;
 *  - a lost race hands back what to rebuild, with the title the upsert
 *    would give it;
 *  - the publish emits the two events the Context tab's delete emits, on the
 *    project's channel, naming the user from the user row (the workflow's
 *    history carries only the id), and is safe to repeat.
 *
 * The database queries have their own tests in
 * `packages/database/__tests__/delete-context-by-source-path.test.ts`.
 *
 * Run with: pnpm --filter @repo/temporal test -- __tests__/synced-context-deletion-activities.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	claimSyncedContextRowForDeletion: vi.fn(),
	deleteClaimedSyncedContextRow: vi.fn(),
	deleteProjectContext: vi.fn(),
	getUserById: vi.fn(),
	emitContextChange: vi.fn(),
	emitActivity: vi.fn(),
	attempt: 1,
}));

vi.mock("@repo/database", () => ({
	claimSyncedContextRowForDeletion: mocks.claimSyncedContextRowForDeletion,
	deleteClaimedSyncedContextRow: mocks.deleteClaimedSyncedContextRow,
	getUserById: mocks.getUserById,
}));

vi.mock("@repo/utils/realtime-emit", () => ({
	emitContextChange: mocks.emitContextChange,
	emitActivity: mocks.emitActivity,
}));

vi.mock("@repo/rag", () => ({
	deleteProjectContext: mocks.deleteProjectContext,
}));

vi.mock("@temporalio/activity", () => ({
	activityInfo: () => ({ attempt: mocks.attempt }),
}));

vi.mock("../src/activities/lib/activity-logger", () => ({
	activityLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	claimSyncedContextForDeletion,
	deleteSyncedContextRow,
	deleteSyncedContextVectors,
	publishSyncedContextDeleted,
} from "../src/activities/synced-context-deletion";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const PATH = "docs/glossary.md";

const TARGET = {
	projectId: "proj-1",
	sourcePath: PATH,
	expectedContentHash: HASH,
	userId: "user-1",
	organizationId: "org-host",
};

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "ctx-1",
		projectId: "proj-1",
		type: "TEXT",
		sourceTitle: null,
		originalFilename: null,
		metadata: { title: "Glossary", sourcePath: PATH },
		sourcePath: PATH,
		contentHash: HASH,
		contentUpdatedAt: new Date("2026-09-22T12:00:00Z"),
		contentUpdatedByUserId: "user-2",
		updatedAt: new Date("2026-09-22T12:00:00Z"),
		qdrantId: "11111111-2222-3333-4444-555555555555",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.attempt = 1;
});

describe("claimSyncedContextForDeletion", () => {
	it("claims under the hosting organization and hands back what the next steps need, as plain JSON", async () => {
		mocks.claimSyncedContextRowForDeletion.mockResolvedValue({
			status: "claimed",
			context: row(),
		});

		const result = await claimSyncedContextForDeletion(TARGET);

		expect(mocks.claimSyncedContextRowForDeletion).toHaveBeenCalledWith(
			TARGET,
		);
		expect(result).toEqual({
			status: "claimed",
			context: {
				contextId: "ctx-1",
				qdrantId: "11111111-2222-3333-4444-555555555555",
				type: "TEXT",
				title: "Glossary",
			},
		});
	});

	it("names a row with no stored title by its path's basename, as the upsert does", async () => {
		mocks.claimSyncedContextRowForDeletion.mockResolvedValue({
			status: "claimed",
			context: row({ metadata: { sourcePath: PATH }, qdrantId: null }),
		});

		const result = await claimSyncedContextForDeletion(TARGET);

		expect(result).toMatchObject({
			status: "claimed",
			context: { title: "glossary.md", qdrantId: null },
		});
	});

	it("passes on absent", async () => {
		mocks.claimSyncedContextRowForDeletion.mockResolvedValue({
			status: "absent",
		});

		expect(await claimSyncedContextForDeletion(TARGET)).toEqual({
			status: "absent",
		});
	});

	it("passes on a conflict with the stored version's date as an ISO string", async () => {
		mocks.claimSyncedContextRowForDeletion.mockResolvedValue({
			status: "conflict",
			current: {
				contextId: "ctx-1",
				contentHash: OTHER_HASH,
				contentUpdatedAt: new Date("2026-09-22T11:00:00Z"),
				contentUpdatedByUserId: "user-2",
			},
		});

		expect(await claimSyncedContextForDeletion(TARGET)).toEqual({
			status: "conflict",
			current: {
				contextId: "ctx-1",
				contentHash: OTHER_HASH,
				contentUpdatedAt: "2026-09-22T11:00:00.000Z",
				contentUpdatedByUserId: "user-2",
			},
		});
	});
});

describe("deleteSyncedContextVectors", () => {
	it("removes the context's points strictly, in the hosting organization's collection", async () => {
		mocks.deleteProjectContext.mockResolvedValue(undefined);

		await deleteSyncedContextVectors({
			contextId: "ctx-1",
			organizationId: "org-host",
			qdrantId: "11111111-2222-3333-4444-555555555555",
		});

		expect(mocks.deleteProjectContext).toHaveBeenCalledWith(
			"ctx-1",
			"org-host",
			"11111111-2222-3333-4444-555555555555",
			{ strict: true },
		);
	});

	it("passes no point id for a row that was never indexed", async () => {
		mocks.deleteProjectContext.mockResolvedValue(undefined);

		await deleteSyncedContextVectors({
			contextId: "ctx-1",
			organizationId: "org-host",
			qdrantId: null,
		});

		expect(mocks.deleteProjectContext).toHaveBeenCalledWith(
			"ctx-1",
			"org-host",
			undefined,
			{ strict: true },
		);
	});

	it("lets a failure through, so Temporal retries it", async () => {
		mocks.deleteProjectContext.mockRejectedValue(
			new Error("Failed to delete project context: timeout"),
		);

		await expect(
			deleteSyncedContextVectors({
				contextId: "ctx-1",
				organizationId: "org-host",
				qdrantId: null,
			}),
		).rejects.toThrow("timeout");
	});
});

describe("deleteSyncedContextRow", () => {
	const input = {
		...TARGET,
		contextId: "ctx-1",
		title: "Glossary",
		operationId: "0b6f1a52-9d3e-4c1a-8f4e-2d7c5b9a3e10",
		audit: {
			via: "v1-api" as const,
			impersonatedById: null,
			ipAddress: "203.0.113.7",
			userAgent: "fabric-cli/1.0",
			requestId: "req-1",
			sessionId: null,
			correlationId: "corr-1",
		},
	};

	it("deletes the claimed row under the hosting organization, handing the query what its audit row records", async () => {
		mocks.deleteClaimedSyncedContextRow.mockResolvedValue({
			status: "deleted",
		});

		expect(await deleteSyncedContextRow(input)).toEqual({
			status: "deleted",
		});
		expect(mocks.deleteClaimedSyncedContextRow).toHaveBeenCalledWith(input);
	});

	it("answers deleted, on any attempt, when the query found this operation's receipt", async () => {
		mocks.deleteClaimedSyncedContextRow.mockResolvedValue({
			status: "deleted",
		});

		for (const attempt of [1, 2, 5]) {
			mocks.attempt = attempt;
			expect(await deleteSyncedContextRow(input)).toEqual({
				status: "deleted",
			});
		}
	});

	it("answers absent, with nothing to rebuild, when the row is gone with no receipt of this operation — even on a retry", async () => {
		mocks.deleteClaimedSyncedContextRow.mockResolvedValue({
			status: "gone",
		});

		// A retry is no proof: attempt 1 may have failed before it committed
		// and somebody else deleted the row in between.
		for (const attempt of [1, 2, 5]) {
			mocks.attempt = attempt;
			expect(await deleteSyncedContextRow(input)).toEqual({
				status: "absent",
				reindex: null,
			});
		}
	});

	it("hands back the moved row to rebuild, under its new path and title", async () => {
		mocks.deleteClaimedSyncedContextRow.mockResolvedValue({
			status: "absent",
			reindex: row({
				sourcePath: "docs/renamed.md",
				metadata: { sourcePath: "docs/renamed.md" },
			}),
		});

		expect(await deleteSyncedContextRow(input)).toEqual({
			status: "absent",
			reindex: {
				contextId: "ctx-1",
				sourcePath: "docs/renamed.md",
				title: "renamed.md",
			},
		});
	});

	it("hands back the changed row to rebuild, with the version now at the path", async () => {
		mocks.deleteClaimedSyncedContextRow.mockResolvedValue({
			status: "conflict",
			current: {
				contextId: "ctx-1",
				contentHash: OTHER_HASH,
				contentUpdatedAt: new Date("2026-09-22T11:00:00Z"),
				contentUpdatedByUserId: "user-2",
			},
			reindex: row({ contentHash: OTHER_HASH }),
		});

		expect(await deleteSyncedContextRow(input)).toEqual({
			status: "conflict",
			current: {
				contextId: "ctx-1",
				contentHash: OTHER_HASH,
				contentUpdatedAt: "2026-09-22T11:00:00.000Z",
				contentUpdatedByUserId: "user-2",
			},
			reindex: {
				contextId: "ctx-1",
				sourcePath: PATH,
				title: "Glossary",
			},
		});
	});
});

describe("publishSyncedContextDeleted", () => {
	const input = {
		organizationId: "org-host",
		projectId: "proj-1",
		contextId: "ctx-1",
		sourcePath: PATH,
		userId: "user-1",
		contextType: "TEXT",
		contextName: "Glossary",
	};

	beforeEach(() => {
		mocks.getUserById.mockResolvedValue({
			id: "user-1",
			name: "Example Dev",
			email: "dev@example.com",
		});
		mocks.emitContextChange.mockResolvedValue(undefined);
		mocks.emitActivity.mockResolvedValue(undefined);
	});

	it("emits the two events the Context tab's delete emits, on the project's channel, naming the user from the user row", async () => {
		await publishSyncedContextDeleted(input);

		expect(mocks.getUserById).toHaveBeenCalledWith("user-1");
		expect(mocks.emitContextChange).toHaveBeenCalledWith({
			projectId: "proj-1",
			contextId: "ctx-1",
			action: "deleted",
			userId: "user-1",
			userName: "Example Dev",
			contextType: "TEXT",
			contextName: "Glossary",
		});
		expect(mocks.emitActivity).toHaveBeenCalledWith({
			projectId: "proj-1",
			userId: "user-1",
			userName: "Example Dev",
			activityType: "context_deleted",
			resourceType: "context",
			resourceId: "ctx-1",
			resourceName: "Glossary",
			timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
		});
	});

	it("names a user whose row is gone, or has no name, Anonymous, as the request did", async () => {
		mocks.getUserById.mockResolvedValue(null);
		await publishSyncedContextDeleted(input);
		mocks.getUserById.mockResolvedValue({ id: "user-1", name: "" });
		await publishSyncedContextDeleted(input);

		for (const [payload] of mocks.emitContextChange.mock.calls) {
			expect(payload.userName).toBe("Anonymous");
		}
		expect(mocks.emitContextChange).toHaveBeenCalledTimes(2);
	});

	it("is safe to repeat: a retry emits the same events again, which the UI treats as one more refresh", async () => {
		await publishSyncedContextDeleted(input);
		await publishSyncedContextDeleted(input);

		expect(mocks.emitContextChange).toHaveBeenCalledTimes(2);
		expect(mocks.emitContextChange.mock.calls[0]).toEqual(
			mocks.emitContextChange.mock.calls[1],
		);
	});

	it("lets a failed user lookup through, so Temporal retries it", async () => {
		mocks.getUserById.mockRejectedValue(new Error("database unavailable"));

		await expect(publishSyncedContextDeleted(input)).rejects.toThrow(
			"database unavailable",
		);
		expect(mocks.emitContextChange).not.toHaveBeenCalled();
	});
});
