import { beforeEach, describe, expect, it, vi } from "vitest";

// Bare unit test: Context.current() throws "Activity context not initialized"
// outside a real Temporal activity execution, so collectStories's
// `Context.current().heartbeat()` needs Context mocked (mirrors
// src/activities/pm-integration/__tests__/fetch-ado-states-heartbeat.test.ts).
vi.mock("@temporalio/activity", () => ({
	Context: { current: () => ({ heartbeat: vi.fn() }) },
}));

interface FakeStoryRow {
	id: string;
	identifier: string;
	title: string;
	createdAt: Date;
	lastEditedAt: Date | null;
	updatedAt: Date;
	projectId: string;
	organizationId: string | null;
}

interface FakeWhere {
	projectId: string;
	project: { organizationId: string | null };
	createdAt?: { gte: Date; lte: Date };
	lastEditedAt: null | { gte: Date; lte: Date };
}

// vi.mock factories are hoisted above all other top-level code, so the mock's
// backing state/fn must be created via vi.hoisted (referencing a plain
// top-level `const` from inside the factory throws "Cannot access before
// initialization" — see fetch-ado-states-heartbeat.test.ts for the same
// pattern in this package).
const { seededRowsRef, findManyMock } = vi.hoisted(() => {
	const seededRowsRef: { current: FakeStoryRow[] } = { current: [] };

	/**
	 * A small in-memory table that actually respects the `where` clause
	 * `collect-stories.ts` builds — this is what proves the tenant guard and
	 * window filter are threaded into the query, rather than merely asserting a
	 * fixed mock return value.
	 */
	const findManyMock = vi.fn(
		(args: { where: FakeWhere; take: number; orderBy: unknown }) => {
			const { where, take } = args;
			const inRange = (date: Date, range: { gte: Date; lte: Date }) =>
				date.getTime() >= range.gte.getTime() &&
				date.getTime() <= range.lte.getTime();

			const matches = seededRowsRef.current.filter((row) => {
				if (row.projectId !== where.projectId) {
					return false;
				}
				if (row.organizationId !== where.project.organizationId) {
					return false;
				}
				if (where.lastEditedAt === null) {
					return (
						row.lastEditedAt === null &&
						where.createdAt !== undefined &&
						inRange(row.createdAt, where.createdAt)
					);
				}
				return (
					row.lastEditedAt !== null &&
					inRange(row.lastEditedAt, where.lastEditedAt)
				);
			});

			const sorted = [...matches].sort((a, b) => {
				const aOrder = a.lastEditedAt ?? a.createdAt;
				const bOrder = b.lastEditedAt ?? b.createdAt;
				return bOrder.getTime() - aOrder.getTime();
			});
			return Promise.resolve(
				sorted.slice(0, take).map((r) => ({
					id: r.id,
					identifier: r.identifier,
					title: r.title,
					createdAt: r.createdAt,
					lastEditedAt: r.lastEditedAt,
				})),
			);
		},
	);

	return { seededRowsRef, findManyMock };
});

vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		db: { userStory: { findMany: findManyMock } },
	};
});

import { PER_SOURCE_CAP } from "@repo/database";
import { collectStories } from "../collect-stories";
import { PER_SOURCE_MAX_BYTES } from "../lib/byte-bound";

const WINDOW_START = "2026-07-01T00:00:00.000Z";
const WINDOW_END = "2026-07-08T00:00:00.000Z";
const IN_WINDOW = new Date("2026-07-04T12:00:00.000Z");

function row(
	overrides: Partial<FakeStoryRow> & Pick<FakeStoryRow, "id">,
): FakeStoryRow {
	return {
		identifier: `US-${overrides.id}`,
		title: `Story ${overrides.id}`,
		createdAt: IN_WINDOW,
		lastEditedAt: IN_WINDOW,
		updatedAt: IN_WINDOW,
		projectId: "proj-a",
		organizationId: "org-a",
		...overrides,
	};
}

beforeEach(() => {
	seededRowsRef.current = [];
	findManyMock.mockClear();
});

describe("collectStories", () => {
	it("does not return an org-B project's stories for an org-A input (tenant filter)", async () => {
		// Story's real owning project belongs to org-b; caller claims org-a.
		seededRowsRef.current = [
			row({ id: "1", projectId: "proj-a", organizationId: "org-b" }),
		];

		const result = await collectStories({
			projectId: "proj-a",
			organizationId: "org-a",
			userId: null,
			windowStart: WINDOW_START,
			windowEnd: WINDOW_END,
		});

		expect(result.items).toEqual([]);
		expect(result.count).toBe(0);
		expect(result.capExhausted).toBe(false);
		// Proves the query was scoped with project: { organizationId } as given.
		expect(findManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: "proj-a",
					project: { organizationId: "org-a" },
				}),
			}),
		);
	});

	it("returns count + capExhausted=false for the base case, correctly scoped", async () => {
		seededRowsRef.current = [row({ id: "1" }), row({ id: "2" })];

		const result = await collectStories({
			projectId: "proj-a",
			organizationId: "org-a",
			userId: null,
			windowStart: WINDOW_START,
			windowEnd: WINDOW_END,
		});

		expect(result.count).toBe(2);
		expect(result.items).toHaveLength(2);
		expect(result.capExhausted).toBe(false);
		expect(result.items[0]?.updatedAt).toEqual(IN_WINDOW);
	});

	it("ignores an operational updatedAt write when no genuine edit is recorded", async () => {
		seededRowsRef.current = [
			row({
				id: "operational-only",
				createdAt: new Date("2026-06-01T00:00:00.000Z"),
				lastEditedAt: null,
				updatedAt: IN_WINDOW,
			}),
		];

		const result = await collectStories({
			projectId: "proj-a",
			organizationId: "org-a",
			userId: null,
			windowStart: WINDOW_START,
			windowEnd: WINDOW_END,
		});

		expect(result.items).toEqual([]);
		expect(findManyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					lastEditedAt: null,
					createdAt: {
						gte: new Date(WINDOW_START),
						lte: new Date(WINDOW_END),
					},
				}),
			}),
		);
	});

	it("sets capExhausted=true when the row count hits PER_SOURCE_CAP", async () => {
		seededRowsRef.current = Array.from(
			{ length: PER_SOURCE_CAP + 5 },
			(_, i) =>
				row({
					id: `s${i}`,
					lastEditedAt: new Date(IN_WINDOW.getTime() - i * 1000),
				}),
		);

		const result = await collectStories({
			projectId: "proj-a",
			organizationId: "org-a",
			userId: null,
			windowStart: WINDOW_START,
			windowEnd: WINDOW_END,
		});

		expect(result.count).toBe(PER_SOURCE_CAP);
		expect(result.capExhausted).toBe(true);
	});

	it("keeps a newer never-edited creation ahead of older edited rows at the cap", async () => {
		seededRowsRef.current = [
			...Array.from({ length: PER_SOURCE_CAP }, (_, i) =>
				row({
					id: `edited-${i}`,
					createdAt: new Date("2026-07-01T01:00:00.000Z"),
					lastEditedAt: new Date(
						new Date("2026-07-02T00:00:00.000Z").getTime() -
							i * 1000,
					),
				}),
			),
			row({
				id: "new-creation",
				createdAt: new Date("2026-07-07T00:00:00.000Z"),
				lastEditedAt: null,
			}),
		];

		const result = await collectStories({
			projectId: "proj-a",
			organizationId: "org-a",
			userId: null,
			windowStart: WINDOW_START,
			windowEnd: WINDOW_END,
		});

		expect(result.items[0]?.id).toBe("new-creation");
		expect(result.items).toHaveLength(PER_SOURCE_CAP);
	});

	it("M5: qualifyingCount is always 0, even for a story closed in-window; items still contains it", async () => {
		seededRowsRef.current = [
			row({ id: "closed-1", title: "Closed story" }),
		];

		const result = await collectStories({
			projectId: "proj-a",
			organizationId: "org-a",
			userId: null,
			windowStart: WINDOW_START,
			windowEnd: WINDOW_END,
		});

		expect(result.qualifyingCount).toBe(0);
		expect(result.newestQualifyingIso).toBeNull();
		expect(result.items.some((i) => i.id === "closed-1")).toBe(true);
	});

	// H3 collector integration test — a byte-trim truncates (not drops) and
	// propagates into capExhausted (source incompleteness → no coverage advance).
	it("byte-bounds an oversized item and propagates the trim into capExhausted", async () => {
		seededRowsRef.current = [
			row({ id: "big-1", title: "x".repeat(PER_SOURCE_MAX_BYTES * 2) }),
		];

		const result = await collectStories({
			projectId: "proj-a",
			organizationId: "org-a",
			userId: null,
			windowStart: WINDOW_START,
			windowEnd: WINDOW_END,
		});

		expect(result.items).toHaveLength(1); // retained, not dropped
		expect(
			Buffer.byteLength(JSON.stringify(result.items), "utf8"),
		).toBeLessThanOrEqual(PER_SOURCE_MAX_BYTES);
		expect(result.capExhausted).toBe(true); // trimmed → capExhausted
	});
});
