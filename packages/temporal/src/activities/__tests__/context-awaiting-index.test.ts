/**
 * The index-only pass for Living Memory rows a sync left unindexed. A pass
 * a sync's index step joined can finish before the content that arrived
 * after it, and the automatic poll starts a run only when the head moves, so
 * without this the row would stay unindexed in a repository that stops
 * changing. Retries back off exponentially (hours 1, 2, 4 ... 64 after the
 * content last changed) so a row that can never index is not restarted
 * forever.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listSyncs: vi.fn(),
	listRows: vi.fn(),
	startEmbedding: vi.fn(),
	getTemporalClient: vi.fn(),
	loggerWarn: vi.fn(),
	CLIENT: { client: true },
}));

vi.mock("@repo/database", () => ({
	listContextRepositorySyncsAwaitingIndex: (...a: unknown[]) =>
		mocks.listSyncs(...a),
	listContextRepositorySyncAwaitingIndexSince: (...a: unknown[]) =>
		mocks.listRows(...a),
}));
vi.mock("../../client", () => ({
	getTemporalClient: (...a: unknown[]) => mocks.getTemporalClient(...a),
}));
vi.mock("../../lib/context-embedding-start", () => ({
	startContextEmbeddingWorkflow: (...a: unknown[]) =>
		mocks.startEmbedding(...a),
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: mocks.loggerWarn, info: vi.fn(), error: vi.fn() },
}));

import {
	AWAITING_INDEX_SYNC_PAGE_SIZE,
	INDEX_RETRY_HOURS,
	isIndexRetryDue,
	MAX_AWAITING_INDEX_STARTS_PER_RUN,
	MAX_AWAITING_INDEX_SYNC_PAGES,
	startAwaitingContextIndexing,
} from "../lib/context-awaiting-index";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-30T12:40:00.000Z");

const SYNC = {
	id: "sync_1",
	projectId: "proj_1",
	organizationId: "org_1",
	userId: "user_1",
};

/** A row whose content last changed `hours` (and a bit) before `NOW`. */
function rowChanged(id: string, hours: number, extraMs = 5 * 60 * 1000) {
	return {
		id,
		sourcePath: `${id}.md`,
		title: id.toUpperCase(),
		changedAt: new Date(NOW - hours * HOUR - extraMs),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.listSyncs.mockResolvedValue([]);
	mocks.listRows.mockResolvedValue([]);
	mocks.startEmbedding.mockResolvedValue({ workflowId: "w" });
	mocks.getTemporalClient.mockResolvedValue(mocks.CLIENT);
});

describe("isIndexRetryDue", () => {
	it.each([1, 2, 4, 8, 16, 32, 64])("retries at hour %i", (hours) => {
		expect(isIndexRetryDue(NOW - hours * HOUR - 1, NOW)).toBe(true);
		expect(isIndexRetryDue(NOW - (hours + 1) * HOUR + 1, NOW)).toBe(true);
	});

	it.each([0, 3, 5, 6, 7, 9, 33, 63, 65, 100])(
		"does not retry at hour %i",
		(hours) => {
			expect(isIndexRetryDue(NOW - hours * HOUR - 1, NOW)).toBe(false);
		},
	);

	it("allows exactly seven automatic retries per content version", () => {
		expect(INDEX_RETRY_HOURS).toHaveLength(7);
		const due = Array.from({ length: 200 }, (_, h) => h).filter((h) =>
			isIndexRetryDue(NOW - h * HOUR - 1, NOW),
		);
		expect(due).toEqual([1, 2, 4, 8, 16, 32, 64]);
	});

	it("restarts the schedule when the content changes again", () => {
		const changedAgain = NOW - 3 * HOUR - 1;
		expect(isIndexRetryDue(changedAgain, NOW)).toBe(false);
		expect(isIndexRetryDue(NOW - 30 * 60 * 1000, NOW)).toBe(false);
		expect(isIndexRetryDue(NOW - 2 * HOUR - 1, NOW)).toBe(true);
	});
});

describe("startAwaitingContextIndexing", () => {
	it("does nothing, and opens no Temporal client, when no sync holds a row in the back-off window", async () => {
		expect(await startAwaitingContextIndexing(NOW)).toEqual({
			syncs: 0,
			started: 0,
			errorCount: 0,
		});

		expect(mocks.listSyncs).toHaveBeenCalledWith({
			changedBetween: {
				from: new Date(NOW - 65 * HOUR),
				to: new Date(NOW - HOUR),
			},
			afterId: null,
			limit: AWAITING_INDEX_SYNC_PAGE_SIZE,
		});
		expect(mocks.getTemporalClient).not.toHaveBeenCalled();
	});

	it("starts the deduplicated guarded embedding only for rows whose hour is in the schedule", async () => {
		mocks.listSyncs.mockResolvedValue([SYNC]);
		mocks.listRows.mockResolvedValue([
			rowChanged("h1", 1),
			rowChanged("h2", 2),
			rowChanged("h3", 3),
			rowChanged("h4", 4),
			rowChanged("h5", 5),
			rowChanged("h64", 64),
			rowChanged("h65", 65),
		]);

		const result = await startAwaitingContextIndexing(NOW);

		expect(result).toEqual({ syncs: 1, started: 4, errorCount: 0 });
		const started = mocks.startEmbedding.mock.calls.map(
			(call) => (call[1] as { contextId: string }).contextId,
		);
		expect(started).toEqual(["h1", "h2", "h4", "h64"]);
		expect(mocks.startEmbedding).toHaveBeenCalledWith(
			mocks.CLIENT,
			{
				contextId: "h1",
				projectId: "proj_1",
				userId: "user_1",
				organizationId: "org_1",
				sourcePath: "h1.md",
				title: "H1",
				reembed: true,
			},
			{ dedupe: true },
		);
	});

	it("opens no Temporal client when no row in the window is due", async () => {
		mocks.listSyncs.mockResolvedValue([SYNC]);
		mocks.listRows.mockResolvedValue([rowChanged("h3", 3)]);

		const result = await startAwaitingContextIndexing(NOW);

		expect(result.started).toBe(0);
		expect(mocks.getTemporalClient).not.toHaveBeenCalled();
	});

	it("leaves the other syncs to run when one sync's start fails", async () => {
		mocks.listSyncs.mockResolvedValue([
			SYNC,
			{ ...SYNC, id: "sync_2", projectId: "proj_2" },
		]);
		mocks.listRows
			.mockRejectedValueOnce(new Error("db down"))
			.mockResolvedValueOnce([rowChanged("b", 1)]);

		const result = await startAwaitingContextIndexing(NOW);

		expect(result).toEqual({ syncs: 2, started: 1, errorCount: 1 });
		expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
	});

	it("stops starting embeddings at the per-run cap", async () => {
		mocks.listSyncs.mockResolvedValue([SYNC]);
		mocks.listRows.mockResolvedValue(
			Array.from(
				{ length: MAX_AWAITING_INDEX_STARTS_PER_RUN + 50 },
				(_, i) => rowChanged(`r${i}`, 1),
			),
		);

		const result = await startAwaitingContextIndexing(NOW);

		expect(result.started).toBe(MAX_AWAITING_INDEX_STARTS_PER_RUN);
		expect(mocks.startEmbedding).toHaveBeenCalledTimes(
			MAX_AWAITING_INDEX_STARTS_PER_RUN,
		);
	});

	it("pages syncs by id and stops at the page cap", async () => {
		let page = 0;
		mocks.listSyncs.mockImplementation(async () => {
			const current = page++;
			return Array.from(
				{ length: AWAITING_INDEX_SYNC_PAGE_SIZE },
				(_, i) => ({
					...SYNC,
					id: `sync_${current}_${String(i).padStart(2, "0")}`,
					projectId: `proj_${current}_${i}`,
				}),
			);
		});

		await startAwaitingContextIndexing(NOW);

		expect(mocks.listSyncs).toHaveBeenCalledTimes(
			MAX_AWAITING_INDEX_SYNC_PAGES,
		);
		expect(mocks.listSyncs.mock.calls[1]?.[0]).toMatchObject({
			afterId: `sync_0_${AWAITING_INDEX_SYNC_PAGE_SIZE - 1}`,
		});
	});
});
