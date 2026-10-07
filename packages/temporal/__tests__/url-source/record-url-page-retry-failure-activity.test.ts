/**
 * Tests for `recordUrlPageRetryFailureActivity`.
 *
 * A page retry sets the page PENDING and keeps its reason; a retry whose
 * fetch fails puts the page back to FAILED, with the fetch failure's reason
 * when the page holds no vectors or a failed fetch had already marked it, and
 * with its earlier reason otherwise. `ProjectContextUrlPage` lives in memory
 * below and every write is applied through its WHERE, so a write that skipped
 * a condition would change a row it must not.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
	const rows: Row[] = [];

	/** Equality, `null`, `startsWith` and `OR` — what the activity's WHEREs use. */
	function matches(row: Row, where: Row): boolean {
		return Object.entries(where).every(([key, condition]) => {
			if (key === "OR") {
				return (condition as Row[]).some((arm) => matches(row, arm));
			}
			if (condition === null) {
				return row[key] === null || row[key] === undefined;
			}
			if (typeof condition === "object" && !(condition instanceof Date)) {
				const c = condition as Row;
				if ("startsWith" in c) {
					const value = row[key];
					return (
						typeof value === "string" &&
						value.startsWith(c.startsWith as string)
					);
				}
				throw new Error(`Unsupported condition on ${key}`);
			}
			return row[key] === condition;
		});
	}

	const urlPage = {
		updateMany: vi.fn(
			async ({ where, data }: { where: Row; data: Row }) => {
				const hit = rows.filter((r) => matches(r, where));
				for (const row of hit) {
					Object.assign(row, data);
				}
				return { count: hit.length };
			},
		),
	};

	return {
		rows,
		urlPage,
		reset: () => {
			rows.length = 0;
		},
	};
});

vi.mock("@repo/database/prisma/client", () => ({
	db: { projectContextUrlPage: h.urlPage },
}));

vi.mock("../../src/activities/lib/activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { URL_PAGE_FETCH_FAILURE_PREFIX } from "@repo/database";
import { recordUrlPageRetryFailureActivity } from "../../src/activities/url-source/record-url-page-retry-failure-activity";

const PAGE_URL = "https://example.com/docs/a";
const EMBEDDED_AT = new Date("2026-10-01T08:01:00.000Z");
const EARLIER_FETCH_FAILURE = `${URL_PAGE_FETCH_FAILURE_PREFIX}Firecrawl timed out`;
const NEW_FETCH_FAILURE = `${URL_PAGE_FETCH_FAILURE_PREFIX}Firecrawl returned 503`;

const input = {
	parentContextId: "ctx-1",
	projectId: "proj-1",
	pageUrl: PAGE_URL,
	reason: "Firecrawl returned 503",
};

/** A page a retry has set PENDING, keeping its reason. */
function retriedPage(fields: Row): Row {
	const row = {
		id: "page-1",
		parentContextId: "ctx-1",
		pageUrl: PAGE_URL,
		content: "# Docs",
		contentHash: "hash-1",
		extractionStatus: "PENDING",
		extractionError: EARLIER_FETCH_FAILURE,
		embeddedAt: EMBEDDED_AT,
		qdrantId: "point-1",
		chunkCount: 3,
		...fields,
	};
	h.rows.push(row);
	return row;
}

describe("recordUrlPageRetryFailureActivity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		h.reset();
	});

	it("marks a page a failed fetch had marked with the new failure, keeping its vectors", async () => {
		const row = retriedPage({});

		const result = await recordUrlPageRetryFailureActivity(input);

		expect(result).toEqual({ outcome: "fetch-failure" });
		expect(row).toMatchObject({
			extractionStatus: "FAILED",
			extractionError: NEW_FETCH_FAILURE,
			content: "# Docs",
			embeddedAt: EMBEDDED_AT,
			qdrantId: "point-1",
			chunkCount: 3,
		});
	});

	it("marks a page that holds no vectors with the new failure, whatever its earlier reason", async () => {
		const row = retriedPage({
			extractionError: "Embedding provider timed out",
			embeddedAt: null,
			qdrantId: null,
			chunkCount: 0,
		});

		const result = await recordUrlPageRetryFailureActivity(input);

		expect(result).toEqual({ outcome: "fetch-failure" });
		expect(row).toMatchObject({
			extractionStatus: "FAILED",
			extractionError: NEW_FETCH_FAILURE,
		});
	});

	// Its vectors may be an earlier version's: a fetch failure's reason would
	// let a later fetch of the stored content complete it.
	it("puts a page that failed for another reason and holds vectors back to FAILED with that reason", async () => {
		const row = retriedPage({
			extractionError: "Embedding provider timed out",
		});

		const result = await recordUrlPageRetryFailureActivity(input);

		expect(result).toEqual({ outcome: "earlier-reason" });
		expect(row).toMatchObject({
			extractionStatus: "FAILED",
			extractionError: "Embedding provider timed out",
			embeddedAt: EMBEDDED_AT,
		});
	});

	it("leaves a page another write has moved off PENDING as it is", async () => {
		const row = retriedPage({
			extractionStatus: "COMPLETED",
			extractionError: null,
		});

		const result = await recordUrlPageRetryFailureActivity(input);

		expect(result).toEqual({ outcome: "none" });
		expect(row).toMatchObject({
			extractionStatus: "COMPLETED",
			extractionError: null,
		});
	});

	it("leaves the same state when recorded again", async () => {
		const row = retriedPage({});

		await recordUrlPageRetryFailureActivity(input);
		const again = await recordUrlPageRetryFailureActivity(input);

		expect(again).toEqual({ outcome: "none" });
		expect(row).toMatchObject({
			extractionStatus: "FAILED",
			extractionError: NEW_FETCH_FAILURE,
		});
	});

	it("changes only the retried page of its own source", async () => {
		const sibling = retriedPage({
			id: "page-2",
			pageUrl: "https://example.com/docs/b",
		});
		const otherSource = retriedPage({
			id: "page-3",
			parentContextId: "ctx-2",
		});
		retriedPage({});

		await recordUrlPageRetryFailureActivity(input);

		expect(sibling.extractionStatus).toBe("PENDING");
		expect(otherSource.extractionStatus).toBe("PENDING");
	});

	describe("when the retry fetched the page but could not index it", () => {
		const indexInput = {
			...input,
			reason: "Embedding provider timed out",
			stage: "index" as const,
		};

		// The upsert rewrote the page (clearing its reason) before the embed
		// threw: its vectors may be the earlier version's.
		it("marks a page the upsert rewrote with the index failure, never a fetch failure", async () => {
			const row = retriedPage({ extractionError: null });

			const result = await recordUrlPageRetryFailureActivity(indexInput);

			expect(result).toEqual({ outcome: "index-failure" });
			expect(row).toMatchObject({
				extractionStatus: "FAILED",
				extractionError:
					"Could not index this page: Embedding provider timed out",
				embeddedAt: EMBEDDED_AT,
			});
		});

		it("puts a page the upsert never reached back to FAILED with its earlier reason", async () => {
			const row = retriedPage({});

			const result = await recordUrlPageRetryFailureActivity(indexInput);

			expect(result).toEqual({ outcome: "earlier-reason" });
			expect(row).toMatchObject({
				extractionStatus: "FAILED",
				extractionError: EARLIER_FETCH_FAILURE,
			});
		});

		it("leaves a page its embed already marked FAILED as it is", async () => {
			const row = retriedPage({
				extractionStatus: "FAILED",
				extractionError: "Unknown embedding error",
			});

			const result = await recordUrlPageRetryFailureActivity(indexInput);

			expect(result).toEqual({ outcome: "none" });
			expect(row.extractionError).toBe("Unknown embedding error");
		});
	});

	it("writes nothing for a company source", async () => {
		const row = retriedPage({});

		const result = await recordUrlPageRetryFailureActivity({
			...input,
			projectId: undefined,
			owner: { kind: "company", organizationId: "org-1" },
		});

		expect(result).toEqual({ outcome: "none" });
		expect(h.urlPage.updateMany).not.toHaveBeenCalled();
		expect(row.extractionStatus).toBe("PENDING");
	});
});
