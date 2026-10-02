/**
 * `updateContextEmbeddingStatus` ends a bulk embed. It must stamp only the rows
 * whose content is still what was embedded, through the guarded query, and it
 * must not fail the batch for a row that was deleted meanwhile. The real-Postgres
 * proof of the guard itself is
 * `packages/database/__tests__/project-context-embedded-stamp.integration.test.ts`;
 * this pins the activity's contract with it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ stampContextsEmbedded: vi.fn() }));

vi.mock("@repo/database", () => ({
	stampContextsEmbedded: (...a: unknown[]) => m.stampContextsEmbedded(...a),
}));
vi.mock("@repo/ai", () => ({ getSystemRAGProviderConfig: vi.fn() }));
vi.mock("@repo/rag", () => ({
	ensureCollection: vi.fn(),
	generateEmbeddings: vi.fn(),
	generatePointId: vi.fn(),
	qdrantClient: {},
}));

import { updateContextEmbeddingStatus } from "../src/activities/project-context-embedding";

beforeEach(() => {
	m.stampContextsEmbedded.mockReset();
	m.stampContextsEmbedded.mockResolvedValue({ stamped: 2, skipped: 0 });
});

describe("updateContextEmbeddingStatus", () => {
	it("hands the guarded query each row's copied content version, tenant-bound to the project", async () => {
		await updateContextEmbeddingStatus({
			projectId: "p",
			contextIds: ["c1", "c2"],
			qdrantIds: ["q1", "q2"],
			versions: [
				{ contentHash: null, updatedAt: "2026-10-01T10:00:00.000Z" },
				{ contentHash: "h", updatedAt: "2026-10-01T10:00:00.000Z" },
			],
		});

		expect(m.stampContextsEmbedded).toHaveBeenCalledWith({
			projectId: "p",
			contexts: [
				{
					id: "c1",
					qdrantId: "q1",
					version: {
						contentHash: null,
						updatedAt: new Date("2026-10-01T10:00:00.000Z"),
					},
				},
				{
					id: "c2",
					qdrantId: "q2",
					version: {
						contentHash: "h",
						updatedAt: new Date("2026-10-01T10:00:00.000Z"),
					},
				},
			],
		});
	});

	it("guards by id alone for an execution started before versions were carried", async () => {
		await updateContextEmbeddingStatus({
			projectId: "p",
			contextIds: ["c1"],
			qdrantIds: ["q1"],
		});

		expect(m.stampContextsEmbedded).toHaveBeenCalledWith({
			projectId: "p",
			contexts: [{ id: "c1", qdrantId: "q1", version: null }],
		});
	});

	it("does not fail when some rows were left unstamped", async () => {
		m.stampContextsEmbedded.mockResolvedValue({ stamped: 1, skipped: 1 });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(
			updateContextEmbeddingStatus({
				projectId: "p",
				contextIds: ["c1", "c2"],
				qdrantIds: ["q1", "q2"],
			}),
		).resolves.toBeUndefined();

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("Left 1 of 2 contexts unstamped"),
		);
		warn.mockRestore();
	});
});
