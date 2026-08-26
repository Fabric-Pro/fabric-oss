import { beforeEach, describe, expect, it, vi } from "vitest";

// Bare unit test: Context.current() throws "Activity context not initialized"
// outside a real Temporal activity execution, so collectDocuments's
// `Context.current().heartbeat()` needs Context mocked (mirrors
// collect-stories.test.ts / fetch-ado-states-heartbeat.test.ts).
vi.mock("@temporalio/activity", () => ({
	Context: { current: () => ({ heartbeat: vi.fn() }) },
}));

interface FakeDocumentRow {
	id: string;
	title: string;
	createdAt: Date;
	updatedAt: Date;
	projectId: string;
	organizationId: string | null;
}

interface FakeVersionRow {
	documentId: string;
	content: string;
	createdAt: Date;
	projectId: string;
	organizationId: string | null;
}

interface FakeDocumentWhere {
	projectId: string;
	project: { organizationId: string | null };
	OR: Array<
		| { createdAt: { gte: Date; lte: Date } }
		| { updatedAt: { gte: Date; lte: Date } }
	>;
}

// vi.mock factories are hoisted above all other top-level code, so the mocks'
// backing state/fns must be created via vi.hoisted (see collect-stories.test.ts).
const {
	seededDocsRef,
	seededVersionsRef,
	findManyDocumentsMock,
	queryRawVersionsMock,
} = vi.hoisted(() => {
	const seededDocsRef: { current: FakeDocumentRow[] } = { current: [] };
	const seededVersionsRef: { current: FakeVersionRow[] } = { current: [] };

	const inRange = (date: Date, range: { gte: Date; lte: Date }) =>
		date.getTime() >= range.gte.getTime() &&
		date.getTime() <= range.lte.getTime();

	/**
	 * Mirrors ProjectDocument.findMany — the raw `items` scan (touched-in-window,
	 * OR createdAt/updatedAt).
	 */
	const findManyDocumentsMock = vi.fn(
		(args: {
			where: FakeDocumentWhere;
			take: number;
			orderBy: unknown;
		}) => {
			const { where, take } = args;
			const matches = seededDocsRef.current.filter((row) => {
				if (row.projectId !== where.projectId) {
					return false;
				}
				if (row.organizationId !== where.project.organizationId) {
					return false;
				}
				return where.OR.some((clause) => {
					if ("createdAt" in clause) {
						return inRange(row.createdAt, clause.createdAt);
					}
					if ("updatedAt" in clause) {
						return inRange(row.updatedAt, clause.updatedAt);
					}
					return false;
				});
			});
			const sorted = [...matches].sort(
				(a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
			);
			return Promise.resolve(
				sorted.slice(0, take).map((r) => ({
					id: r.id,
					title: r.title,
					updatedAt: r.updatedAt,
				})),
			);
		},
	);

	/**
	 * Mirrors the raw `db.$queryRaw` qualification scan (F7) — filters IN "SQL"
	 * on projectId / organizationId (IS NOT DISTINCT FROM semantics — a null org
	 * matches a null org) / createdAt window / substantive content length, and
	 * never surfaces `content` in the returned rows (only documentId + createdAt),
	 * mirroring that the real query never selects it into JS either. Positional:
	 * the collector interpolates `${projectId} ${organizationId} ${start} ${end}
	 * ${MIN_DOC_CONTENT_CHARS} ${take}` in that order.
	 */
	const queryRawVersionsMock = vi.fn(
		(
			_strings: TemplateStringsArray,
			projectId: string,
			organizationId: string | null,
			start: Date,
			end: Date,
			minChars: number,
			take: number,
		) => {
			const matches = seededVersionsRef.current.filter((row) => {
				if (row.projectId !== projectId) {
					return false;
				}
				if (row.organizationId !== organizationId) {
					return false; // IS NOT DISTINCT FROM: null === null matches
				}
				if (!inRange(row.createdAt, { gte: start, lte: end })) {
					return false;
				}
				return row.content.trim().length >= minChars;
			});
			const sorted = [...matches].sort(
				(a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
			);
			return Promise.resolve(
				sorted.slice(0, take).map((r) => ({
					documentId: r.documentId,
					createdAt: r.createdAt,
				})),
			);
		},
	);

	return {
		seededDocsRef,
		seededVersionsRef,
		findManyDocumentsMock,
		queryRawVersionsMock,
	};
});

vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		db: {
			projectDocument: { findMany: findManyDocumentsMock },
			$queryRaw: queryRawVersionsMock,
		},
	};
});

import { MIN_DOC_CONTENT_CHARS, PER_SOURCE_CAP } from "@repo/database";
import { collectDocuments } from "../collect-documents";

const WINDOW_START = "2026-07-01T00:00:00.000Z";
const WINDOW_END = "2026-07-08T00:00:00.000Z";
const IN_WINDOW = new Date("2026-07-04T12:00:00.000Z");

function docRow(
	overrides: Partial<FakeDocumentRow> & Pick<FakeDocumentRow, "id">,
): FakeDocumentRow {
	return {
		title: `Doc ${overrides.id}`,
		createdAt: IN_WINDOW,
		updatedAt: IN_WINDOW,
		projectId: "proj-a",
		organizationId: "org-a",
		...overrides,
	};
}

function versionRow(
	overrides: Partial<FakeVersionRow> & Pick<FakeVersionRow, "documentId">,
): FakeVersionRow {
	return {
		content: "x".repeat(MIN_DOC_CONTENT_CHARS + 50), // substantive by default
		createdAt: IN_WINDOW,
		projectId: "proj-a",
		organizationId: "org-a",
		...overrides,
	};
}

function baseInput() {
	return {
		projectId: "proj-a",
		organizationId: "org-a",
		userId: null,
		windowStart: WINDOW_START,
		windowEnd: WINDOW_END,
	};
}

beforeEach(() => {
	seededDocsRef.current = [];
	seededVersionsRef.current = [];
	findManyDocumentsMock.mockClear();
	queryRawVersionsMock.mockClear();
});

describe("collectDocuments", () => {
	it("qualifyingCount counts distinct documentIds, not version rows (2 versions of doc-1 + 1 of doc-2, all substantive => 2)", async () => {
		seededVersionsRef.current = [
			versionRow({ documentId: "doc-1", createdAt: IN_WINDOW }),
			versionRow({
				documentId: "doc-1",
				createdAt: new Date(IN_WINDOW.getTime() + 1000),
			}),
			versionRow({ documentId: "doc-2", createdAt: IN_WINDOW }),
		];

		const result = await collectDocuments(baseInput());

		expect(result.qualifyingCount).toBe(2);
	});

	it("excludes a version whose trimmed content is under MIN_DOC_CONTENT_CHARS", async () => {
		seededVersionsRef.current = [
			versionRow({ documentId: "doc-1", content: "short" }),
			versionRow({
				documentId: "doc-2",
				content: "x".repeat(MIN_DOC_CONTENT_CHARS), // exactly at the boundary — qualifies
			}),
		];

		const result = await collectDocuments(baseInput());

		expect(result.qualifyingCount).toBe(1);
	});

	it("sets capExhausted=true when the bounded DocumentVersion scan returns more than PER_SOURCE_CAP rows", async () => {
		seededVersionsRef.current = Array.from(
			{ length: PER_SOURCE_CAP + 5 },
			(_, i) =>
				versionRow({
					documentId: `doc-${i}`,
					createdAt: new Date(IN_WINDOW.getTime() - i * 1000),
				}),
		);

		const result = await collectDocuments(baseInput());

		expect(result.capExhausted).toBe(true);
	});

	it("newestQualifyingIso is the max createdAt among substantive versions, as an ISO string", async () => {
		const older = IN_WINDOW;
		const newer = new Date(IN_WINDOW.getTime() + 3_600_000);
		seededVersionsRef.current = [
			versionRow({ documentId: "doc-1", createdAt: older }),
			versionRow({ documentId: "doc-2", createdAt: newer }),
		];

		const result = await collectDocuments(baseInput());

		expect(result.newestQualifyingIso).toBe(newer.toISOString());
	});

	it("newestQualifyingIso is null when no versions qualify", async () => {
		seededVersionsRef.current = [
			versionRow({ documentId: "doc-1", content: "short" }),
		];

		const result = await collectDocuments(baseInput());

		expect(result.qualifyingCount).toBe(0);
		expect(result.newestQualifyingIso).toBeNull();
	});

	it("does not count an org-B document's versions or items for an org-A input (tenant filter)", async () => {
		seededDocsRef.current = [
			docRow({
				id: "doc-1",
				projectId: "proj-a",
				organizationId: "org-b",
			}),
		];
		seededVersionsRef.current = [
			versionRow({
				documentId: "doc-1",
				projectId: "proj-a",
				organizationId: "org-b",
			}),
		];

		const result = await collectDocuments(baseInput());

		expect(result.items).toEqual([]);
		expect(result.qualifyingCount).toBe(0);
		expect(result.newestQualifyingIso).toBeNull();
		expect(findManyDocumentsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: "proj-a",
					project: { organizationId: "org-a" },
				}),
			}),
		);
		// $queryRaw is a tagged-template call: (strings, projectId, organizationId, ...).
		// Assert the tenant-scope args threaded through, not org-b's.
		const [, queryProjectId, queryOrganizationId] =
			queryRawVersionsMock.mock.calls.at(-1) ?? [];
		expect(queryProjectId).toBe("proj-a");
		expect(queryOrganizationId).toBe("org-a");
	});
});
