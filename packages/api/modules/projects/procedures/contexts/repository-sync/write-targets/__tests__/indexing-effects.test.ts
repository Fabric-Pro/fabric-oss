/**
 * What a write folder's indexing choice sets in motion once its transaction
 * has committed (`settleIndexingChange`): the vectors of rows that became
 * Store only are deleted (one bounded drain of each queued cleanup record,
 * the sweep finishing what is left), and the files that became indexable are
 * embedded through the guarded, deduplicated pass.
 *
 * Neither may fail the request: the change itself is already committed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	drainPendingVectorCleanup: vi.fn(),
	listContextRepositorySyncAwaitingIndex: vi.fn(),
	startContextEmbeddingWorkflow: vi.fn(),
	getTemporalClient: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("@repo/temporal/delete-channel-context", () => ({
	drainPendingVectorCleanup: m.drainPendingVectorCleanup,
}));
vi.mock("@repo/temporal/context-embedding-start", () => ({
	startContextEmbeddingWorkflow: m.startContextEmbeddingWorkflow,
}));
vi.mock("@repo/temporal", () => ({ getTemporalClient: m.getTemporalClient }));
vi.mock("@repo/database", () => ({
	listContextRepositorySyncAwaitingIndex:
		m.listContextRepositorySyncAwaitingIndex,
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: m.warn, info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(options: T) => options,
}));

import {
	MAX_INDEX_STARTS_PER_CHANGE,
	settleIndexingChange,
} from "../indexing-effects";

const base = {
	projectId: "proj-1",
	organizationId: "org-1",
	syncId: "sync-1",
	userId: "user-1",
};
const none = { excluded: 0, included: 0, cleanups: [] };

const row = (i: number) => ({
	id: `ctx-${i}`,
	sourcePath: `docs/tasks/${String(i).padStart(4, "0")}.md`,
	title: `Task ${i}`,
});

beforeEach(() => {
	vi.resetAllMocks();
	m.drainPendingVectorCleanup.mockResolvedValue(undefined);
	m.getTemporalClient.mockResolvedValue({ workflow: {} });
	m.listContextRepositorySyncAwaitingIndex.mockResolvedValue([]);
	m.startContextEmbeddingWorkflow.mockResolvedValue({ workflowId: "w" });
});

describe("settleIndexingChange", () => {
	it("does nothing when no row changed state", async () => {
		await settleIndexingChange({ ...base, reindex: none });

		expect(m.drainPendingVectorCleanup).not.toHaveBeenCalled();
		expect(m.getTemporalClient).not.toHaveBeenCalled();
		expect(m.listContextRepositorySyncAwaitingIndex).not.toHaveBeenCalled();
	});

	it("drains each queued vector cleanup", async () => {
		const cleanups = [
			{ id: "c-1", contextIds: ["a"] },
			{ id: "c-2", contextIds: ["b"] },
		];

		await settleIndexingChange({
			...base,
			reindex: { excluded: 2, included: 0, cleanups },
		});

		expect(m.drainPendingVectorCleanup).toHaveBeenCalledTimes(2);
		expect(m.drainPendingVectorCleanup).toHaveBeenCalledWith(cleanups[0]);
		expect(m.drainPendingVectorCleanup).toHaveBeenCalledWith(cleanups[1]);
		expect(m.startContextEmbeddingWorkflow).not.toHaveBeenCalled();
	});

	it("leaves a cleanup that fails to the sweep, without failing the change", async () => {
		m.drainPendingVectorCleanup.mockRejectedValue(new Error("qdrant down"));

		await expect(
			settleIndexingChange({
				...base,
				reindex: {
					excluded: 1,
					included: 0,
					cleanups: [{ id: "c-1", contextIds: ["a"] }],
				},
			}),
		).resolves.toBeUndefined();

		expect(m.warn).toHaveBeenCalled();
	});

	it("starts the guarded, deduplicated embedding of each file that became indexable", async () => {
		m.listContextRepositorySyncAwaitingIndex.mockResolvedValueOnce([
			row(1),
			row(2),
		]);

		await settleIndexingChange({
			...base,
			reindex: { excluded: 0, included: 2, cleanups: [] },
		});

		expect(m.startContextEmbeddingWorkflow).toHaveBeenCalledTimes(2);
		expect(m.startContextEmbeddingWorkflow).toHaveBeenCalledWith(
			expect.anything(),
			{
				contextId: "ctx-1",
				projectId: "proj-1",
				userId: "user-1",
				organizationId: "org-1",
				sourcePath: "docs/tasks/0001.md",
				title: "Task 1",
				reembed: true,
			},
			expect.objectContaining({ dedupe: true }),
		);
	});

	it("starts at most the per-change bound, leaving the rest to the next sync run", async () => {
		const page = (from: number, count: number) =>
			Array.from({ length: count }, (_, i) => row(from + i));
		m.listContextRepositorySyncAwaitingIndex.mockImplementation(
			async (
				_scope: unknown,
				_syncId: string,
				{
					afterKey,
					limit,
				}: { afterKey?: string | null; limit: number },
			) => {
				const from = afterKey ? Number(afterKey.slice(-7, -3)) + 1 : 0;
				return page(from, limit);
			},
		);

		await settleIndexingChange({
			...base,
			reindex: { excluded: 0, included: 4000, cleanups: [] },
		});

		expect(m.startContextEmbeddingWorkflow).toHaveBeenCalledTimes(
			MAX_INDEX_STARTS_PER_CHANGE,
		);
	});

	it("does not fail the change when embeddings cannot be started", async () => {
		m.getTemporalClient.mockRejectedValue(new Error("temporal down"));

		await expect(
			settleIndexingChange({
				...base,
				reindex: { excluded: 0, included: 3, cleanups: [] },
			}),
		).resolves.toBeUndefined();

		expect(m.warn).toHaveBeenCalled();
	});
});
