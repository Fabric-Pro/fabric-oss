/**
 * Tests for listContexts pagination behavior.
 *
 * Regression test for Fizzy #1023: the Context tab was silently truncated
 * to 50 rows sorted by createdAt desc, which hid GitHub / Notion / codebase
 * / file contexts on projects whose 50 newest rows were all meeting
 * transcripts. The fix adds a `limit: "none"` escape hatch so the oRPC
 * `list-contexts` procedure can disable pagination for the UI.
 *
 * Run with: pnpm --filter @repo/database test __tests__/list-contexts.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type ContextRow = {
	id: string;
	projectId: string;
	type: string;
	createdAt: Date;
};

const findManyMock = vi.fn();
const countMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		projectContext: {
			findMany: (args: unknown) => findManyMock(args),
			count: (args: unknown) => countMock(args),
		},
	},
	Prisma: { sql: vi.fn() },
}));

import { listContexts } from "../prisma/queries/projects/contexts";

function seedMixedContexts(total: number): ContextRow[] {
	// First 50 rows (newest by createdAt) are MEETING_TRANSCRIPT, the rest
	// are an even mix of INTEGRATION / FILE / TEXT. This mirrors the Fizzy
	// #1023 repro where a sweep imported 50+ transcripts and pushed older
	// source types out of a paginated window.
	const baseTime = new Date("2026-04-10T00:00:00Z").getTime();
	const otherTypes = ["INTEGRATION", "FILE", "TEXT"] as const;
	const rows: ContextRow[] = [];
	for (let i = 0; i < total; i++) {
		const isTranscript = i < 50;
		const otherType = otherTypes[i % otherTypes.length] ?? "FILE";
		rows.push({
			id: `ctx-${i}`,
			projectId: "proj-1",
			type: isTranscript ? "MEETING_TRANSCRIPT" : otherType,
			// Newer rows first (descending createdAt).
			createdAt: new Date(baseTime - i * 1000),
		});
	}
	return rows;
}

describe("listContexts", () => {
	beforeEach(() => {
		findManyMock.mockReset();
		countMock.mockReset();
	});

	it('returns every row when limit is "none" (Fizzy #1023 regression)', async () => {
		const all = seedMixedContexts(67);
		findManyMock.mockResolvedValue(all);
		countMock.mockResolvedValue(all.length);

		const result = await listContexts({
			projectId: "proj-1",
			excludeLinkedDocuments: true,
			limit: "none",
		});

		// Query must NOT include take/skip when pagination is disabled —
		// otherwise older non-transcript rows fall outside the window.
		expect(findManyMock).toHaveBeenCalledTimes(1);
		const findManyArgs = findManyMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(findManyArgs).not.toHaveProperty("take");
		expect(findManyArgs).not.toHaveProperty("skip");
		expect(findManyArgs).toMatchObject({
			where: {
				projectId: "proj-1",
				importedDocuments: { none: {} },
			},
			orderBy: { createdAt: "desc" },
		});

		expect(result.contexts).toHaveLength(67);
		expect(result.total).toBe(67);
		expect(result.hasMore).toBe(false);

		// Regression assertion: all source types are represented, not just
		// MEETING_TRANSCRIPT. This is the exact failure reported on Fizzy #1023.
		const types = new Set(result.contexts.map((c) => c.type));
		expect(types).toContain("MEETING_TRANSCRIPT");
		expect(types).toContain("INTEGRATION");
		expect(types).toContain("FILE");
		expect(types).toContain("TEXT");
	});

	it("defaults to 50-row pagination for batching callers", async () => {
		const firstPage = seedMixedContexts(67).slice(0, 50);
		findManyMock.mockResolvedValue(firstPage);
		countMock.mockResolvedValue(67);

		const result = await listContexts({ projectId: "proj-1" });

		expect(findManyMock).toHaveBeenCalledTimes(1);
		const findManyArgs = findManyMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(findManyArgs).toMatchObject({
			take: 50,
			skip: 0,
			orderBy: { createdAt: "desc" },
		});
		expect(result.contexts).toHaveLength(50);
		expect(result.total).toBe(67);
		expect(result.hasMore).toBe(true);
	});

	it("reports hasMore=false on the last paginated page", async () => {
		const lastPage = seedMixedContexts(67).slice(50);
		findManyMock.mockResolvedValue(lastPage);
		countMock.mockResolvedValue(67);

		const result = await listContexts({
			projectId: "proj-1",
			limit: 50,
			offset: 50,
		});

		expect(result.contexts).toHaveLength(17);
		expect(result.total).toBe(67);
		expect(result.hasMore).toBe(false);
	});
});
