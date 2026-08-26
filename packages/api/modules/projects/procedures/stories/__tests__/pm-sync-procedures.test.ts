/**
 * Integration tests for the PM-sync API surface (F-1166 Task Group 4).
 *
 * Covers:
 *   - update-story enqueues `pmSyncSingleStoryWorkflow` only when the story
 *     has `externalId` AND the project has a PM config (Task 4.2).
 *   - retry-pm-sync re-enqueues the workflow for an owned story (Task 4.6).
 *   - retry-pm-sync-batch fans out per-story enqueue calls (Task 4.7).
 *   - check-pm-sync-conflicts filters cross-tenant story IDs out and starts
 *     `pmSyncPreviewConflictsWorkflow` with the owned subset (Task 4.5).
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		updateStory: vi.fn(),
		userStoryFindFirst: vi.fn(),
		userStoryUpdate: vi.fn(),
		userStoryFindMany: vi.fn(),
		featureFindFirst: vi.fn(),
		featureUpdate: vi.fn(),
		featureFindMany: vi.fn(),
		epicFindFirst: vi.fn(),
		epicUpdate: vi.fn(),
		epicFindMany: vi.fn(),
		projectFindUnique: vi.fn(),
		mcpServerFindUnique: vi.fn(),
		workflowStart: vi.fn(),
		resolvePMConfigForUser: vi.fn(),
		applyPmUnlink: vi.fn(),
		pendingUpdateMany: vi.fn(),
		clearPmSyncFailure: vi.fn(),
		clearPmSyncFailures: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	updateStory: mocks.updateStory,
	applyPmUnlink: mocks.applyPmUnlink,
	clearPmSyncFailure: mocks.clearPmSyncFailure,
	clearPmSyncFailures: mocks.clearPmSyncFailures,
	// `preview-pm-sync-conflicts` now resolves the project PM tool via the
	// sentinel helpers too (PR #1205 catalog-row-missing case). Inline shims
	// matching the production semantics: `key:` prefix marks a sentinel; the
	// reader strips it. UUID-style mcpServerIds in these tests don't match the
	// prefix, so the code falls through to `db.mCPServer.findUnique`.
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
		feature: {
			findFirst: mocks.featureFindFirst,
			findMany: mocks.featureFindMany,
			update: mocks.featureUpdate,
		},
		epic: {
			findFirst: mocks.epicFindFirst,
			findMany: mocks.epicFindMany,
			update: mocks.epicUpdate,
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
	FeatureDraftingStageSchema: z.enum([
		"PLACEHOLDER",
		"ACTIVE_ANALYSIS",
		"SANITY_CHECK",
		"DRAFT",
		"PUBLISHED",
		"DECLINED",
		"CLOSED",
	]),
	MaturationStatusSchema: z.enum(["TO_DO", "DISCOVERY", "DONE"]),
	resolvePMConfigForUser: mocks.resolvePMConfigForUser,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: mocks.workflowStart },
	})),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = [
		"updateStory",
		"checkPmSyncConflicts",
		"retryPmSync",
		"retryPmSyncBatch",
		"dismissPmSyncFailure",
		"dismissPmSyncFailureBatch",
	];
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

// Stub the notification fan-out so the `@repo/database` mock above doesn't
// need to expose NotificationType / NotificationCategory — `update-story.ts`
// transitively imports `notification-service.ts` which references those
// enums at module load.
vi.mock("../../../../../lib/notification-service", () => ({
	fanOut: {
		mention: vi.fn(),
		reply: vi.fn(),
		assigned: vi.fn(),
	},
}));

await import("../update-story");
await import("../preview-pm-sync-conflicts");
await import("../retry-pm-sync");
await import("../retry-pm-sync-batch");
await import("../dismiss-pm-sync-failure");
await import("../dismiss-pm-sync-failure-batch");

const ctx = { user: { id: "user-1" }, session: {} };

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	// Default: pinned configId resolves to the same id (same-user happy path).
	mocks.resolvePMConfigForUser.mockImplementation(
		async ({ configId }: { configId: string | null }) =>
			configId ? { id: configId, enabled: true } : null,
	);
	// Default: MCP server lookup yields no key unless a test opts in.
	mocks.mcpServerFindUnique.mockResolvedValue(null);
});

describe("updateStoryProcedure — PM sync enqueue (Task 4.2)", () => {
	const baseInput = {
		projectId: "project-1",
		storyId: "story-1",
		title: "Updated title",
		organizationId: null,
	};

	// =========================================================================
	// 4-case PM-sync gate matrix — spec §9.1 lines 996–1000.
	//
	// The four cases below cover every combination of {toggle, externalId}
	// against a content-touching update (title changed). The matrix is
	// CONTIGUOUS in this block so future edits cannot leave a corner
	// uncovered without an explicit removal.
	//
	//   #  pmAutoSyncEnabled  externalId  input change                 enqueue?
	//   1  true               "EXT-1"     title                        called (forceInitialPush=false)
	//   2  false              "EXT-1"     title                        not called
	//   3  true (just flipped) null       only pmAutoSyncEnabled=true  called (forceInitialPush=true)
	//   4  false              null        title                        not called
	// =========================================================================

	it("matrix #1 — toggle ON + linked + content diff → enqueues without forceInitialPush", async () => {
		// pmAutoSyncEnabled=true mirrors the migration backfill on every
		// pre-existing PM-linked row — the new gate reads this
		// from the post-update story shape, not the input.
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
			pmAutoSyncEnabled: true,
		});
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
		});
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: "org-1",
			projectManagementMcpConfigId: "mcp-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: "Container",
			projectManagementAdditionalContext: null,
		});
		mocks.userStoryUpdate.mockResolvedValue({});
		mocks.workflowStart.mockResolvedValue({ workflowId: "wf-1" });

		await handlers.updateStory({ input: baseInput, context: ctx });
		// Allow the void-floated promise to resolve.
		await new Promise((r) => setImmediate(r));

		expect(mocks.userStoryUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastPmSyncStatus: "PENDING",
				}),
			}),
		);
		// `forceInitialPush` is intentionally not propagated to the workflow
		// args (`enqueuePmSync` consumes it locally to decide whether to skip
		// the no-external-id short-circuit). The proof that
		// `forceInitialPush=false` was passed here is that the workflow start
		// fires for a story that ALREADY has externalId — the only path that
		// could have reached the workflow start with externalId="EXT-1".
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"pmSyncSingleStoryWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						itemId: "story-1",
						itemType: "story",
						triggerSource: "manual-edit",
					}),
				],
			}),
		);
	});

	it("matrix #2 — toggle OFF + linked + content diff → does NOT enqueue", async () => {
		// New gate: a linked feature with the toggle off skips the PM push
		// silently even when the user edited PM-relevant content. The
		// previous behavior (always push when externalId is set) is gone
		// — the toggle is now the source of truth.
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
			pmAutoSyncEnabled: false,
		});
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
		});

		await handlers.updateStory({ input: baseInput, context: ctx });
		await new Promise((r) => setImmediate(r));

		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("matrix #3 — toggle just-flipped ON + unlinked + only toggle in input → enqueues with forceInitialPush", async () => {
		// Toggle armed: input.pmAutoSyncEnabled=true on a story that previously
		// had no externalId fires enqueuePmSync with forceInitialPush=true so
		// the workflow's create-then-link branch runs. We assert
		// this indirectly: the workflow start firing for an unlinked story
		// can only happen when forceInitialPush bypassed the no-external-id
		// short-circuit in `enqueuePmSync`.
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			externalId: null,
			pmAutoSyncEnabled: true,
		});
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: null,
		});
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: null,
			projectManagementMcpConfigId: "mcp-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});
		mocks.userStoryUpdate.mockResolvedValue({});
		mocks.workflowStart.mockResolvedValue({ workflowId: "wf-initial" });

		await handlers.updateStory({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				pmAutoSyncEnabled: true,
			},
			context: ctx,
		});
		await new Promise((r) => setImmediate(r));

		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"pmSyncSingleStoryWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						itemId: "story-1",
						itemType: "story",
						triggerSource: "manual-edit",
					}),
				],
			}),
		);
	});

	it("matrix #4 — toggle OFF + unlinked + content diff → does NOT enqueue", async () => {
		// Belt-and-braces: a Fabric-only feature with the toggle off and
		// no externalId is the most common state for a brand-new feature
		// during draft. Editing the title must not trigger a PM push.
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			externalId: null,
			pmAutoSyncEnabled: false,
		});
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: null,
		});

		await handlers.updateStory({ input: baseInput, context: ctx });
		await new Promise((r) => setImmediate(r));

		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("matrix sentinel — toggle ON (backfilled) + unlinked + content diff (no toggle flip) → no workflow", async () => {
		// Backfilled-true sentinel: the persisted toggle is true (e.g. the
		// story is from before the migration cleanup) but the user hasn't
		// flipped it again in this PATCH (input lacks pmAutoSyncEnabled).
		// The procedure-level gate passes (touchedPmContent=true) and
		// `enqueuePmSync` is invoked, but its internal `no-external-id`
		// short-circuit fires (forceInitialPush=false), so neither
		// `markPending` nor `workflowStart` runs. This guards the boundary
		// between the two layers — without it, a future refactor could
		// accidentally drop the inner short-circuit and silently push
		// to PM with a missing externalId.
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			externalId: null,
			pmAutoSyncEnabled: true,
		});
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: null,
		});

		await handlers.updateStory({ input: baseInput, context: ctx });
		await new Promise((r) => setImmediate(r));

		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("matrix #5 — toggle ON + linked + metadata-only diff (priority/size) → does NOT enqueue", async () => {
		// Spec §9.1 case 5: kanban metadata edits (priority, size, assignee,
		// draftingStage) do NOT touch fields the PM tool stores,
		// so `touchedPmContent` is false and the gate in update-story.ts
		// short-circuits BEFORE calling enqueuePmSync. This guards the
		// "no-op revision in PM" rule from spec §5.1.
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
			pmAutoSyncEnabled: true,
		});
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
		});

		await handlers.updateStory({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				priority: "P1_HIGH",
				size: "M",
			},
			context: ctx,
		});
		await new Promise((r) => setImmediate(r));

		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("enqueues for description-only update", async () => {
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
			pmAutoSyncEnabled: true,
		});
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
		});
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: null,
			projectManagementMcpConfigId: "mcp-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});
		mocks.userStoryUpdate.mockResolvedValue({});
		mocks.workflowStart.mockResolvedValue({ workflowId: "wf-2" });

		await handlers.updateStory({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				description: "New description",
			},
			context: ctx,
		});
		await new Promise((r) => setImmediate(r));

		expect(mocks.workflowStart).toHaveBeenCalled();
	});

	it("matrix #6 — toggle ON + linked + content diff but project has no PM config → workflow not started", async () => {
		// Spec §9.1 case 6: the procedure-level gate passes (toggle on,
		// content touched, externalId set), so `enqueuePmSync` is invoked.
		// Inside, the `no-pm-config` short-circuit fires because the
		// project has neither `projectManagementMcpConfigId` nor
		// `projectManagementContainerId`. End result: no workflow start
		// and no PENDING write — silent skip, no exception.
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
			pmAutoSyncEnabled: true,
		});
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
		});
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: null,
			projectManagementMcpConfigId: null,
			projectManagementContainerId: null,
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});

		await handlers.updateStory({ input: baseInput, context: ctx });
		await new Promise((r) => setImmediate(r));

		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});

describe("retryPmSyncProcedure (Task 4.6)", () => {
	const input = {
		projectId: "project-1",
		storyId: "story-1",
		itemType: "story" as const,
		pushAnyway: false,
		organizationId: null,
	};

	it("re-enqueues PM sync for an owned story with triggerSource=retry", async () => {
		mocks.userStoryFindFirst
			// retry procedure tenant verification
			.mockResolvedValueOnce({ id: "story-1" })
			// enqueuePmSync inner lookup
			.mockResolvedValueOnce({ id: "story-1", externalId: "EXT-1" });
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: null,
			projectManagementMcpConfigId: "mcp-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});
		mocks.userStoryUpdate.mockResolvedValue({});
		mocks.workflowStart.mockResolvedValue({ workflowId: "wf-retry-1" });

		const result = await handlers.retryPmSync({ input, context: ctx });

		expect(result).toEqual(
			expect.objectContaining({
				enqueued: true,
				workflowId: "wf-retry-1",
			}),
		);
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"pmSyncSingleStoryWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						triggerSource: "retry",
						pushAnyway: false,
					}),
				],
			}),
		);
	});

	it("unlinkFirst severs the dead link, dismisses the pending FLAG_MISSING, and arms the re-create push", async () => {
		mocks.userStoryFindFirst
			// resolveItemLink — the item's current (dead) link
			.mockResolvedValueOnce({
				externalId: "EXT-1",
				externalMcpServerId: "srv-1",
			})
			// enqueuePmSync inner lookup — unlinked now; forceInitialPush lets it
			// proceed to the CREATE path instead of short-circuiting on no-external-id.
			.mockResolvedValueOnce({ id: "story-1", externalId: null });
		mocks.applyPmUnlink.mockResolvedValue({ applied: true });
		mocks.pendingUpdateMany.mockResolvedValue({ count: 1 });
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: null,
			projectManagementMcpConfigId: "mcp-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});
		mocks.userStoryUpdate.mockResolvedValue({});
		mocks.workflowStart.mockResolvedValue({ workflowId: "wf-recreate-1" });

		const result = await handlers.retryPmSync({
			input: { ...input, unlinkFirst: true },
			context: ctx,
		});

		// Severs the link using the row's current provenance (the atomic predicate).
		expect(mocks.applyPmUnlink).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-1",
				entityType: "STORY",
				entityId: "story-1",
				expectedExternalId: "EXT-1",
				expectedExternalMcpServerId: "srv-1",
			}),
		);
		// Dismisses the now-stale "ticket missing" proposal so the Review Center
		// doesn't show an unlink suggestion for an item we just unlinked.
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
		// And re-enqueues — enqueued:true proves forceInitialPush bypassed the
		// no-external-id short-circuit so the CREATE path runs.
		expect(result).toEqual(
			expect.objectContaining({
				enqueued: true,
				workflowId: "wf-recreate-1",
			}),
		);
	});

	it("rejects with NOT_FOUND for cross-tenant story", async () => {
		mocks.userStoryFindFirst.mockResolvedValueOnce(null);

		await expect(
			handlers.retryPmSync({ input, context: ctx }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});

describe("retryPmSyncBatchProcedure (Task 4.7)", () => {
	const baseInput = {
		projectId: "project-1",
		items: [
			{ id: "story-1", itemType: "story" as const },
			{ id: "story-2", itemType: "story" as const },
			{ id: "story-cross-tenant", itemType: "story" as const },
		],
		organizationId: null,
	};

	it("filters cross-tenant items and enqueues only owned ones", async () => {
		mocks.projectFindUnique.mockResolvedValue({ id: "project-1" });
		mocks.userStoryFindMany.mockResolvedValue([
			{ id: "story-1" },
			{ id: "story-2" },
		]);
		mocks.userStoryFindFirst.mockImplementation(({ where }) =>
			Promise.resolve({ id: where.id, externalId: "EXT-X" }),
		);
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: null,
			projectManagementMcpConfigId: "mcp-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});
		mocks.userStoryUpdate.mockResolvedValue({});
		mocks.workflowStart.mockResolvedValue({ workflowId: "wf-x" });

		const result = (await handlers.retryPmSyncBatch({
			input: baseInput,
			context: ctx,
		})) as {
			enqueuedCount: number;
			results: Array<{ id: string; itemType: string }>;
		};

		expect(result.enqueuedCount).toBe(2);
		expect(result.results.map((r) => r.id).sort()).toEqual([
			"story-1",
			"story-2",
		]);
		expect(mocks.workflowStart).toHaveBeenCalledTimes(2);
	});

	it("filters legacy feature/epic itemTypes and only enqueues stories", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: null,
			projectManagementMcpConfigId: "mcp-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});
		mocks.userStoryFindMany.mockResolvedValue([{ id: "story-1" }]);
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-S",
		});
		mocks.userStoryUpdate.mockResolvedValue({});
		mocks.workflowStart.mockResolvedValue({ workflowId: "wf-mixed" });

		const result = (await handlers.retryPmSyncBatch({
			input: {
				projectId: "project-1",
				items: [
					{ id: "story-1", itemType: "story" },
					{ id: "feature-1", itemType: "feature" },
					{ id: "epic-1", itemType: "epic" },
				],
				organizationId: null,
			},
			context: ctx,
		})) as {
			enqueuedCount: number;
			results: Array<{ id: string; itemType: string }>;
		};

		// Legacy `feature`/`epic` itemTypes can't resolve a row (the folder
		// tables were dropped) — they are filtered out before enqueue; only
		// the story syncs, and the folder tables are never queried.
		expect(result.enqueuedCount).toBe(1);
		expect(result.results).toHaveLength(1);
		expect(result.results[0]).toMatchObject({
			id: "story-1",
			itemType: "story",
		});
		expect(mocks.userStoryFindMany).toHaveBeenCalled();
		expect(mocks.featureFindMany).not.toHaveBeenCalled();
		expect(mocks.epicFindMany).not.toHaveBeenCalled();
	});
});

describe("checkPmSyncConflictsProcedure (Task 4.5)", () => {
	const baseInput = {
		projectId: "project-1",
		items: [
			{ id: "story-1", itemType: "story" as const },
			{ id: "story-2", itemType: "story" as const },
			{ id: "story-other-tenant", itemType: "story" as const },
		],
		organizationId: null,
	};

	it("filters cross-tenant items and starts the preview workflow", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: null,
			projectManagementMcpConfigId: "mcp-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});
		mocks.userStoryFindMany.mockResolvedValue([
			{ id: "story-1" },
			{ id: "story-2" },
		]);
		mocks.featureFindMany.mockResolvedValue([]);
		mocks.epicFindMany.mockResolvedValue([]);
		mocks.workflowStart.mockResolvedValue({
			workflowId: "wf-preview-1",
			result: () =>
				Promise.resolve({
					results: [
						{
							id: "story-1",
							itemType: "story",
							hasConflict: true,
						},
						{
							id: "story-2",
							itemType: "story",
							hasConflict: false,
						},
					],
				}),
		});

		const result = (await handlers.checkPmSyncConflicts({
			input: baseInput,
			context: ctx,
		})) as {
			results: Array<{
				id: string;
				itemType: string;
				hasConflict: boolean;
			}>;
		};

		expect(result.results).toHaveLength(3);
		expect(
			result.results.find((r) => r.id === "story-other-tenant"),
		).toEqual({
			id: "story-other-tenant",
			itemType: "story",
			hasConflict: false,
			pmTool: null,
		});
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"pmSyncPreviewConflictsWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						items: [
							{ id: "story-1", itemType: "story" },
							{ id: "story-2", itemType: "story" },
						],
						projectId: "project-1",
					}),
				],
			}),
		);
	});

	it("resolves legacy feature/epic items as no-conflict without querying folder tables", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: null,
			projectManagementMcpConfigId: "mcp-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});

		const result = (await handlers.checkPmSyncConflicts({
			input: {
				projectId: "project-1",
				items: [
					{ id: "feature-1", itemType: "feature" },
					{ id: "epic-1", itemType: "epic" },
				],
				organizationId: null,
			},
			context: ctx,
		})) as {
			results: Array<{
				id: string;
				itemType: string;
				hasConflict: boolean;
			}>;
		};

		// Legacy `feature`/`epic` itemTypes can't resolve a row (the folder
		// tables were dropped) — the preview short-circuits with hasConflict
		// false for every item, never queries the folder tables, and never
		// starts the preview workflow.
		expect(result.results).toHaveLength(2);
		expect(result.results.every((r) => r.hasConflict === false)).toBe(true);
		expect(mocks.featureFindMany).not.toHaveBeenCalled();
		expect(mocks.epicFindMany).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("surfaces author/date from the workflow result and derives pmTool (Group 3)", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: null,
			projectManagementMcpConfigId: "mcp-1",
			projectManagementMcpServerId: "srv-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});
		mocks.mcpServerFindUnique.mockResolvedValue({ key: "azure-devops" });
		mocks.userStoryFindMany.mockResolvedValue([{ id: "story-1" }]);
		mocks.featureFindMany.mockResolvedValue([]);
		mocks.epicFindMany.mockResolvedValue([]);
		mocks.workflowStart.mockResolvedValue({
			workflowId: "wf-preview-author",
			result: () =>
				Promise.resolve({
					results: [
						{
							id: "story-1",
							itemType: "story",
							hasConflict: true,
							pmCurrent: {
								title: "PM Title",
								description: "PM body",
								lastChangedBy: "Dana Lee",
								lastChangedAt: "2026-05-26T10:00:00.000Z",
							},
						},
					],
				}),
		});

		const result = (await handlers.checkPmSyncConflicts({
			input: {
				projectId: "project-1",
				items: [{ id: "story-1", itemType: "story" }],
				organizationId: null,
			},
			context: ctx,
		})) as {
			results: Array<{
				id: string;
				pmTool: string | null;
				pmCurrent?: {
					lastChangedBy: string | null;
					lastChangedAt: string | null;
				};
			}>;
		};

		const found = result.results.find((r) => r.id === "story-1");
		expect(found?.pmTool).toBe("azure-devops");
		expect(found?.pmCurrent?.lastChangedBy).toBe("Dana Lee");
		expect(found?.pmCurrent?.lastChangedAt).toBe(
			"2026-05-26T10:00:00.000Z",
		);
		expect(mocks.mcpServerFindUnique).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "srv-1" } }),
		);
	});

	it("passes null author/date through when the PM tool does not capture them (Group 3)", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: null,
			projectManagementMcpConfigId: "mcp-1",
			projectManagementMcpServerId: "srv-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});
		mocks.mcpServerFindUnique.mockResolvedValue({ key: "trello" });
		mocks.userStoryFindMany.mockResolvedValue([{ id: "story-1" }]);
		mocks.featureFindMany.mockResolvedValue([]);
		mocks.epicFindMany.mockResolvedValue([]);
		mocks.workflowStart.mockResolvedValue({
			workflowId: "wf-preview-null",
			result: () =>
				Promise.resolve({
					results: [
						{
							id: "story-1",
							itemType: "story",
							hasConflict: true,
							pmCurrent: {
								title: "PM Title",
								description: "PM body",
								lastChangedBy: null,
								lastChangedAt: null,
							},
						},
					],
				}),
		});

		const result = (await handlers.checkPmSyncConflicts({
			input: {
				projectId: "project-1",
				items: [{ id: "story-1", itemType: "story" }],
				organizationId: null,
			},
			context: ctx,
		})) as {
			results: Array<{
				id: string;
				pmTool: string | null;
				pmCurrent?: {
					lastChangedBy: string | null;
					lastChangedAt: string | null;
				};
			}>;
		};

		const found = result.results.find((r) => r.id === "story-1");
		expect(found?.pmTool).toBe("trello");
		expect(found?.pmCurrent?.lastChangedBy).toBeNull();
		expect(found?.pmCurrent?.lastChangedAt).toBeNull();
	});

	it("returns no-conflict for all items when project has no PM config", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: null,
			projectManagementMcpConfigId: null,
			projectManagementContainerId: null,
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});

		const result = (await handlers.checkPmSyncConflicts({
			input: baseInput,
			context: ctx,
		})) as {
			results: Array<{ hasConflict: boolean }>;
		};

		expect(result.results.every((r) => r.hasConflict === false)).toBe(true);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});

describe("dismissPmSyncFailureProcedure", () => {
	it("clears a FAILED item via clearPmSyncFailure and reports dismissed:true", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({ id: "story-1" });
		mocks.clearPmSyncFailure.mockResolvedValue({ cleared: 1 });

		const result = (await handlers.dismissPmSyncFailure({
			input: {
				projectId: "proj-1",
				storyId: "story-1",
				itemType: "story",
				organizationId: null,
			},
			context: ctx,
		})) as { dismissed: boolean };

		expect(mocks.clearPmSyncFailure).toHaveBeenCalledWith({
			itemType: "story",
			itemId: "story-1",
			projectId: "proj-1",
		});
		expect(result.dismissed).toBe(true);
	});

	it("reports dismissed:false when the item was not in FAILED state (cleared 0)", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({ id: "story-1" });
		mocks.clearPmSyncFailure.mockResolvedValue({ cleared: 0 });

		const result = (await handlers.dismissPmSyncFailure({
			input: {
				projectId: "proj-1",
				storyId: "story-1",
				itemType: "story",
				organizationId: null,
			},
			context: ctx,
		})) as { dismissed: boolean };

		expect(result.dismissed).toBe(false);
	});

	it("throws NOT_FOUND and never clears when the item is absent from the project (tenant guard)", async () => {
		mocks.userStoryFindFirst.mockResolvedValue(null);

		await expect(
			handlers.dismissPmSyncFailure({
				input: {
					projectId: "proj-1",
					storyId: "missing",
					itemType: "story",
					organizationId: null,
				},
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.clearPmSyncFailure).not.toHaveBeenCalled();
	});

	it("scopes the existence check to the project (where id + projectId)", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({ id: "story-1" });
		mocks.clearPmSyncFailure.mockResolvedValue({ cleared: 1 });

		await handlers.dismissPmSyncFailure({
			input: {
				projectId: "proj-1",
				storyId: "story-1",
				itemType: "story",
				organizationId: null,
			},
			context: ctx,
		});

		expect(mocks.userStoryFindFirst).toHaveBeenCalledWith({
			where: { id: "story-1", projectId: "proj-1" },
			select: { id: true },
		});
	});
});

describe("dismissPmSyncFailureBatchProcedure", () => {
	it("clears the selected story/bug ids via clearPmSyncFailures and returns the count", async () => {
		mocks.projectFindUnique.mockResolvedValue({ id: "proj-1" });
		mocks.clearPmSyncFailures.mockResolvedValue({ cleared: 2 });

		const result = (await handlers.dismissPmSyncFailureBatch({
			input: {
				projectId: "proj-1",
				items: [
					{ id: "s1", itemType: "story" },
					{ id: "s2", itemType: "bug" },
				],
				organizationId: null,
			},
			context: ctx,
		})) as { dismissedCount: number };

		expect(mocks.clearPmSyncFailures).toHaveBeenCalledWith({
			projectId: "proj-1",
			itemIds: ["s1", "s2"],
		});
		expect(result.dismissedCount).toBe(2);
	});

	it("filters out legacy epic/feature ids before clearing (stories are the only rows)", async () => {
		mocks.projectFindUnique.mockResolvedValue({ id: "proj-1" });
		mocks.clearPmSyncFailures.mockResolvedValue({ cleared: 1 });

		await handlers.dismissPmSyncFailureBatch({
			input: {
				projectId: "proj-1",
				items: [
					{ id: "s1", itemType: "story" },
					{ id: "e1", itemType: "epic" },
				],
				organizationId: null,
			},
			context: ctx,
		});

		expect(mocks.clearPmSyncFailures).toHaveBeenCalledWith({
			projectId: "proj-1",
			itemIds: ["s1"],
		});
	});

	it("returns dismissedCount 0 and skips DB work for an empty item list", async () => {
		const result = (await handlers.dismissPmSyncFailureBatch({
			input: { projectId: "proj-1", items: [], organizationId: null },
			context: ctx,
		})) as { dismissedCount: number };

		expect(result.dismissedCount).toBe(0);
		expect(mocks.clearPmSyncFailures).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND when the project does not exist", async () => {
		mocks.projectFindUnique.mockResolvedValue(null);

		await expect(
			handlers.dismissPmSyncFailureBatch({
				input: {
					projectId: "missing",
					items: [{ id: "s1", itemType: "story" }],
					organizationId: null,
				},
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
	});
});
