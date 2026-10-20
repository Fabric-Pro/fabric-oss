/**
 * Living Memory "Store only" write folders (ADR-022): the row flag
 * `project_context.indexingExcluded`, derived from the sync's write folders
 * by `reconcileContextIndexing`, and every query that must honour it.
 *
 * What this pins:
 *  - every query that finds rows "awaiting index" skips excluded rows, so a
 *    store-only file (which keeps `embeddedAt` NULL for good) is never
 *    started, retried or counted;
 *  - every query that feeds context summarization skips excluded rows;
 *  - the reconcile clears the unindexed marks of rows that became store-only
 *    and queues their vectors for deletion in chunks, in the caller's
 *    transaction, and only for rows that held vectors;
 *  - a row that stopped being store-only is reported as to be indexed.
 *
 * Run with: pnpm --filter @repo/database exec vitest run __tests__/context-index-mode.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	context: {
		count: vi.fn(),
		findMany: vi.fn(),
		updateMany: vi.fn(),
	},
	sync: { findMany: vi.fn() },
	cleanup: { create: vi.fn() },
	$queryRaw: vi.fn(),
}));

vi.mock("../prisma/client", async () => {
	const { join, sqltag } = await vi.importActual<
		typeof import("@prisma/client/runtime/client")
	>("@prisma/client/runtime/client");
	return {
		db: new Proxy(
			{
				projectContext: m.context,
				projectContextRepositorySync: m.sync,
				$queryRaw: (...a: unknown[]) => m.$queryRaw(...a),
			} as Record<string, unknown>,
			{
				// Tables a query reads besides the one under test answer empty.
				get: (target, name: string) =>
					name in target
						? target[name]
						: {
								findMany: async () => [],
								count: async () => 0,
							},
			},
		),
		Prisma: { join, sql: sqltag, empty: sqltag`` },
	};
});

import {
	countRawContextChars,
	countRawContextRows,
	fetchProjectContextBatch,
	getContextVolumeCandidates,
	listContextSummarySources,
} from "../prisma/queries/project-context-summaries";
import {
	CONTEXT_INDEX_CLEANUP_CHUNK,
	reconcileContextIndexing,
} from "../prisma/queries/projects/context-index-mode";
import {
	countAwaitingIndexContexts,
	listContextRepositorySyncAwaitingIndex,
	listContextRepositorySyncAwaitingIndexSince,
	listContextRepositorySyncsAwaitingIndex,
	listUnindexedSyncedContexts,
} from "../prisma/queries/projects/context-repository-sync";

const scope = { projectId: "proj-1", organizationId: "org-1" };

beforeEach(() => {
	vi.resetAllMocks();
	m.context.count.mockResolvedValue(0);
	m.context.findMany.mockResolvedValue([]);
	m.sync.findMany.mockResolvedValue([]);
	m.$queryRaw.mockResolvedValue([]);
});

describe("awaiting-index queries skip store-only rows", () => {
	it("countAwaitingIndexContexts", async () => {
		await countAwaitingIndexContexts(scope, "sync-1");

		expect(m.context.count.mock.calls[0]?.[0].where).toMatchObject({
			embeddedAt: null,
			indexingExcluded: false,
		});
	});

	it("listUnindexedSyncedContexts", async () => {
		await listUnindexedSyncedContexts(scope, 10);

		expect(m.context.findMany.mock.calls[0]?.[0].where).toMatchObject({
			embeddedAt: null,
			indexingExcluded: false,
		});
	});

	it("listContextRepositorySyncAwaitingIndex", async () => {
		await listContextRepositorySyncAwaitingIndex(scope, "sync-1", {
			limit: 5,
		});

		expect(m.context.findMany.mock.calls[0]?.[0].where).toMatchObject({
			embeddedAt: null,
			indexingExcluded: false,
		});
	});

	it("listContextRepositorySyncAwaitingIndexSince", async () => {
		await listContextRepositorySyncAwaitingIndexSince(scope, "sync-1", {
			changedBetween: { from: new Date(0), to: new Date() },
			limit: 5,
		});

		expect(m.context.findMany.mock.calls[0]?.[0].where).toMatchObject({
			embeddedAt: null,
			indexingExcluded: false,
		});
	});

	it("listContextRepositorySyncsAwaitingIndex only picks syncs that hold an indexable unindexed row", async () => {
		await listContextRepositorySyncsAwaitingIndex({
			changedBetween: { from: new Date(0), to: new Date() },
			limit: 5,
		});

		expect(
			m.sync.findMany.mock.calls[0]?.[0].where.contexts.some,
		).toMatchObject({ embeddedAt: null, indexingExcluded: false });
	});
});

describe("summarization queries skip store-only rows", () => {
	const tenancy = { userId: null, organizationId: "org-1" };

	it("countRawContextChars", async () => {
		await countRawContextChars({ projectId: "proj-1" });

		expect(m.context.findMany.mock.calls[0]?.[0].where).toMatchObject({
			indexingExcluded: false,
		});
	});

	it("countRawContextRows", async () => {
		await countRawContextRows({ projectId: "proj-1", tenancy });

		expect(m.context.count.mock.calls[0]?.[0].where).toMatchObject({
			indexingExcluded: false,
		});
	});

	it("fetchProjectContextBatch", async () => {
		await fetchProjectContextBatch({
			projectId: "proj-1",
			tenancy,
			snapshotThrough: new Date(),
			afterCreatedAt: null,
			afterId: null,
			maxChars: 1000,
		});

		expect(m.context.findMany.mock.calls[0]?.[0].where).toMatchObject({
			indexingExcluded: false,
		});
	});

	it("listContextSummarySources", async () => {
		await listContextSummarySources({
			projectId: "proj-1",
			tenancy,
			includeCodeRepo: false,
		});

		expect(m.context.findMany.mock.calls[0]?.[0].where).toMatchObject({
			indexingExcluded: false,
		});
	});

	it("getContextVolumeCandidates excludes them from the grouped volume", async () => {
		await getContextVolumeCandidates({ minChars: 100 });

		const [strings] = m.$queryRaw.mock.calls[0] as [string[]];
		expect(strings.join("?")).toContain('NOT "indexingExcluded"');
	});
});

describe("reconcileContextIndexing", () => {
	const tx = {
		$queryRaw: (...a: unknown[]) => m.$queryRaw(...a),
		projectContext: m.context,
		projectContextPendingVectorCleanup: m.cleanup,
	};
	const input = { ...scope, syncId: "sync-1", actingUserId: "user-1" };

	beforeEach(() => {
		m.cleanup.create.mockImplementation(async () => ({
			id: `cleanup-${m.cleanup.create.mock.calls.length}`,
		}));
		m.context.updateMany.mockResolvedValue({ count: 0 });
	});

	/** The `updateMany` calls that clear unindexed marks, as opposed to the settle. */
	const clearMarksCalls = () =>
		m.context.updateMany.mock.calls.filter(
			(c) => c[0].data.extractionStatus === undefined,
		);

	it("does nothing when no row changes state", async () => {
		m.$queryRaw.mockResolvedValue([]);

		const result = await reconcileContextIndexing(tx as never, input);

		expect(result).toEqual({ excluded: 0, included: 0, cleanups: [] });
		expect(clearMarksCalls()).toEqual([]);
		expect(m.cleanup.create).not.toHaveBeenCalled();
	});

	it("settles store-only rows still reading PENDING, whether or not their flag just changed", async () => {
		m.$queryRaw.mockResolvedValue([]);

		await reconcileContextIndexing(tx as never, input);

		expect(m.context.updateMany).toHaveBeenCalledWith({
			where: {
				projectId: "proj-1",
				organizationId: "org-1",
				repositorySyncId: "sync-1",
				indexingExcluded: true,
				extractionStatus: "PENDING",
			},
			data: {
				extractionStatus: "COMPLETED",
				extractedAt: expect.any(Date),
			},
		});
	});

	it("settles only the paths a batch names", async () => {
		await reconcileContextIndexing(tx as never, {
			...input,
			sourcePaths: ["docs/tasks/a.md"],
		});

		expect(m.context.updateMany.mock.calls[0]?.[0].where).toMatchObject({
			sourcePath: { in: ["docs/tasks/a.md"] },
			indexingExcluded: true,
			extractionStatus: "PENDING",
		});
	});

	it("marks rows that became store-only unindexed and queues their vectors in chunks", async () => {
		const total = CONTEXT_INDEX_CLEANUP_CHUNK * 2 + 50;
		m.$queryRaw.mockResolvedValue(
			Array.from({ length: total }, (_, i) => ({
				id: `ctx-${i}`,
				indexingExcluded: true,
				hadVectors: true,
			})),
		);

		const result = await reconcileContextIndexing(tx as never, input);

		expect(result.excluded).toBe(total);
		expect(result.included).toBe(0);
		expect(m.context.updateMany).toHaveBeenCalledWith({
			where: {
				id: {
					in: expect.arrayContaining(["ctx-0", `ctx-${total - 1}`]),
				},
				projectId: "proj-1",
				organizationId: "org-1",
				indexingExcluded: true,
			},
			data: { embeddedAt: null, qdrantId: null },
		});
		expect(m.cleanup.create).toHaveBeenCalledTimes(3);
		const sizes = m.cleanup.create.mock.calls.map(
			(c) => c[0].data.contextIds.length,
		);
		expect(sizes).toEqual([
			CONTEXT_INDEX_CLEANUP_CHUNK,
			CONTEXT_INDEX_CLEANUP_CHUNK,
			50,
		]);
		expect(m.cleanup.create.mock.calls[0]?.[0].data).toMatchObject({
			projectId: "proj-1",
			organizationId: "org-1",
		});
		expect(result.cleanups.map((c) => c.contextIds.length)).toEqual(sizes);
	});

	it("queues nothing for a row that never held vectors", async () => {
		m.$queryRaw.mockResolvedValue([
			{ id: "fresh", indexingExcluded: true, hadVectors: false },
		]);

		const result = await reconcileContextIndexing(tx as never, input);

		expect(result).toMatchObject({ excluded: 1, cleanups: [] });
		expect(m.cleanup.create).not.toHaveBeenCalled();
	});

	it("reports rows that stopped being store-only as to be indexed", async () => {
		m.$queryRaw.mockResolvedValue([
			{ id: "a", indexingExcluded: false, hadVectors: false },
			{ id: "b", indexingExcluded: false, hadVectors: false },
		]);

		const result = await reconcileContextIndexing(tx as never, input);

		expect(result).toEqual({ excluded: 0, included: 2, cleanups: [] });
		expect(clearMarksCalls()).toEqual([]);
	});
});
