/**
 * `embedProjectContextsProcedure` copies the content of every unembedded
 * context into the embedding workflow's input. Three things matter here:
 *
 *  - a synced row (repository sync or `fabric context push`) is never copied:
 *    its content changes in place, so the copy may be replaced before it lands
 *    in the index, and an older copy landing after a newer embed would leave
 *    stale text searchable;
 *  - such a row that still awaits indexing is handed to the hash-guarded pass
 *    instead (deduplicated per row), which re-reads its body itself;
 *  - every copied row carries the content version it was copied at, so the
 *    stamp after the embed can leave a row that changed in between alone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	findUnique: vi.fn(),
	workflowStart: vi.fn(),
	listUnindexedSyncedContexts: vi.fn(),
	startContextEmbeddingWorkflow: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: (...a: unknown[]) => m.findUnique(...a) } },
	listUnindexedSyncedContexts: (...a: unknown[]) =>
		m.listUnindexedSyncedContexts(...a),
}));
vi.mock("@repo/temporal/context-embedding-start", () => ({
	startContextEmbeddingWorkflow: (...a: unknown[]) =>
		m.startContextEmbeddingWorkflow(...a),
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: (...a: unknown[]) => m.workflowStart(...a) },
	}),
}));
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const b = {
		use: () => b,
		route: () => b,
		input: () => b,
		handler: (fn: (...a: unknown[]) => unknown) => {
			m.handlers.embed = fn;
			return fn;
		},
	};
	return {
		tenantProtectedProcedure: b,
		requireProjectPermission: () => ({}),
		Permissions: { CONTEXT_UPDATE: "context:update" },
	};
});

import "../embed-contexts";

const ctx = { user: { id: "user_1" } };

beforeEach(() => {
	m.findUnique.mockReset();
	m.workflowStart.mockReset();
	m.workflowStart.mockResolvedValue({
		workflowId: "wf",
		firstExecutionRunId: "run",
	});
	m.listUnindexedSyncedContexts.mockReset();
	m.listUnindexedSyncedContexts.mockResolvedValue([]);
	m.startContextEmbeddingWorkflow.mockReset();
	m.startContextEmbeddingWorkflow.mockResolvedValue({ workflowId: "ce" });
});

describe("projects.contexts.embed", () => {
	it("hands unindexed synced rows to the guarded pass and copies none of them", async () => {
		m.findUnique.mockResolvedValue({
			organizationId: "org_1",
			contexts: [],
		});
		m.listUnindexedSyncedContexts.mockResolvedValue([
			{ id: "s1", sourcePath: "notes/a.md", title: "a.md" },
			{ id: "s2", sourcePath: "notes/b.md", title: "B" },
		]);

		const result = await m.handlers.embed!({
			input: { projectId: "p" },
			context: ctx,
		});

		expect(m.listUnindexedSyncedContexts).toHaveBeenCalledWith(
			{ projectId: "p", organizationId: "org_1" },
			200,
		);
		expect(m.startContextEmbeddingWorkflow).toHaveBeenCalledTimes(2);
		expect(m.startContextEmbeddingWorkflow).toHaveBeenCalledWith(
			expect.anything(),
			{
				contextId: "s1",
				projectId: "p",
				userId: "user_1",
				organizationId: "org_1",
				sourcePath: "notes/a.md",
				title: "a.md",
				reembed: true,
			},
			expect.objectContaining({ dedupe: true }),
		);
		expect(m.workflowStart).not.toHaveBeenCalled();
		expect(result).toEqual(expect.objectContaining({ contextCount: 2 }));
	});

	it("asks only for unembedded rows that are not synced", async () => {
		m.findUnique.mockResolvedValue({
			organizationId: "org_1",
			contexts: [],
		});

		await m.handlers.embed!({ input: { projectId: "p" }, context: ctx });

		expect(m.findUnique).toHaveBeenCalledWith(
			expect.objectContaining({
				include: expect.objectContaining({
					contexts: {
						where: {
							embeddedAt: null,
							type: { not: "INTEGRATION" },
							sourcePath: null,
						},
					},
				}),
			}),
		);
	});

	it("carries each row's content version into the workflow input", async () => {
		const updatedAt = new Date("2026-10-01T10:00:00.000Z");
		m.findUnique.mockResolvedValue({
			organizationId: "org_1",
			contexts: [
				{
					id: "c1",
					type: "TEXT",
					content: "hello",
					contentHash: null,
					updatedAt,
				},
				{
					id: "c2",
					type: "TEXT",
					content: "hi",
					contentHash: "h".repeat(64),
					updatedAt,
				},
			],
		});

		await m.handlers.embed!({ input: { projectId: "p" }, context: ctx });

		const [, options] = m.workflowStart.mock.calls[0]! as [
			string,
			{ args: Array<{ contexts: unknown[] }> },
		];
		expect(options.args[0]?.contexts).toEqual([
			{
				id: "c1",
				type: "TEXT",
				content: "hello",
				contentHash: null,
				updatedAt: "2026-10-01T10:00:00.000Z",
			},
			{
				id: "c2",
				type: "TEXT",
				content: "hi",
				contentHash: "h".repeat(64),
				updatedAt: "2026-10-01T10:00:00.000Z",
			},
		]);
	});
});
