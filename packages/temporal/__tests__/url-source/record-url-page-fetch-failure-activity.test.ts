/**
 * Tests for `recordUrlPageFetchFailureActivity` with a project owner.
 *
 * A crawl that cannot fetch a page keeps it instead of pruning it: the page
 * row is marked FAILED with why, keeping its content and vectors, and a URL
 * the parent has no row for gets a FAILED row unless the failure is
 * permanent. `ProjectContextUrlPage` lives in memory below and every write
 * is applied through its WHERE, so a write that skipped a condition would
 * change a row it must not.
 *
 * The company owner's tests are in
 * `src/activities/url-source/__tests__/company-url-source.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
	const rows: Row[] = [];

	/** Equality, `in`, `null` and `OR` — what the activity's WHEREs use. */
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
				if ("in" in c) {
					return (c.in as unknown[]).includes(row[key]);
				}
				throw new Error(`Unsupported condition on ${key}`);
			}
			return row[key] === condition;
		});
	}

	const pick = (row: Row, select?: Record<string, boolean>) =>
		select
			? Object.fromEntries(
					Object.keys(select).map((key) => [key, row[key]]),
				)
			: { ...row };

	let seq = 0;
	const urlPage = {
		findFirst: vi.fn(
			async ({
				where,
				select,
			}: {
				where: Row;
				select?: Record<string, boolean>;
			}) => {
				const row = rows.find((r) => matches(r, where));
				return row ? pick(row, select) : null;
			},
		),
		create: vi.fn(
			async ({
				data,
				select,
			}: {
				data: Row;
				select?: Record<string, boolean>;
			}) => {
				const row = { id: `created-${++seq}`, ...data };
				rows.push(row);
				return pick(row, select);
			},
		),
		updateMany: vi.fn(
			async ({ where, data }: { where: Row; data: Row }) => {
				const hit = rows.filter((r) => matches(r, where));
				for (const row of hit) {
					Object.assign(row, data);
				}
				return { count: hit.length };
			},
		),
		update: vi.fn(),
		deleteMany: vi.fn(async ({ where }: { where: Row }) => {
			const before = rows.length;
			for (let i = rows.length - 1; i >= 0; i--) {
				if (matches(rows[i] as Row, where)) {
					rows.splice(i, 1);
				}
			}
			return { count: before - rows.length };
		}),
	};

	return {
		rows,
		urlPage,
		reset: () => {
			rows.length = 0;
			seq = 0;
		},
	};
});

vi.mock("@repo/database/prisma/client", () => ({
	db: { projectContextUrlPage: h.urlPage },
}));

vi.mock("@repo/rag", () => ({
	resolveCompanyEmbeddingModel: vi.fn(),
	deleteCompanyContextRowPoints: vi.fn(),
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
import {
	deleteCompanyContextRowPoints,
	resolveCompanyEmbeddingModel,
} from "@repo/rag";
import { recordUrlPageFetchFailureActivity } from "../../src/activities/url-source/record-url-page-fetch-failure-activity";

const PAGE_URL = "https://example.com/docs/a";
const FETCHED_AT = new Date("2026-10-01T08:00:00.000Z");
const EMBEDDED_AT = new Date("2026-10-01T08:01:00.000Z");
const REASON = `${URL_PAGE_FETCH_FAILURE_PREFIX}Firecrawl timed out`;

const input = (over: Record<string, unknown> = {}) => ({
	parentContextId: "ctx-1",
	projectId: "proj-1",
	pageUrl: PAGE_URL,
	reason: "Firecrawl timed out",
	permanent: false,
	userId: "user-1",
	organizationId: "org-a",
	...over,
});

/** A page a crawl fetched and embedded: searchable. */
function seedIndexedPage(over: Row = {}): Row {
	const row: Row = {
		id: "page-1",
		parentContextId: "ctx-1",
		projectId: "proj-1",
		pageUrl: PAGE_URL,
		pageTitle: "A",
		content: "# A",
		contentHash: "a".repeat(64),
		qdrantId: "point-1",
		embeddedAt: EMBEDDED_AT,
		chunkCount: 3,
		lastFetchedAt: FETCHED_AT,
		extractionStatus: "COMPLETED",
		extractionError: null,
		userId: "user-1",
		organizationId: "org-a",
		...over,
	};
	h.rows.push(row);
	return row;
}

/** A row bulk-init made for a URL no fetch has written yet. */
function seedPlaceholder(over: Row = {}): Row {
	return seedIndexedPage({
		id: "page-2",
		pageUrl: `${PAGE_URL}/placeholder`,
		pageTitle: null,
		content: "",
		contentHash: "",
		qdrantId: null,
		embeddedAt: null,
		chunkCount: 0,
		extractionStatus: "PENDING",
		...over,
	});
}

describe("recordUrlPageFetchFailureActivity with a project owner", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		h.reset();
	});

	it("marks an indexed page FAILED with the reason, keeping its content, vectors and fetch time", async () => {
		const page = seedIndexedPage();
		const before = { ...page };

		await expect(
			recordUrlPageFetchFailureActivity(input()),
		).resolves.toEqual({ kept: true });

		expect(page).toEqual({
			...before,
			extractionStatus: "FAILED",
			extractionError: REASON,
		});
		expect(h.urlPage.updateMany.mock.calls[0][0].data).toEqual({
			extractionStatus: "FAILED",
			extractionError: REASON,
		});
	});

	it("marks a CANCELLED leftover and a placeholder without vectors FAILED", async () => {
		const cancelled = seedIndexedPage({ extractionStatus: "CANCELLED" });
		const placeholder = seedPlaceholder();

		await expect(
			recordUrlPageFetchFailureActivity(input()),
		).resolves.toEqual({ kept: true });
		await expect(
			recordUrlPageFetchFailureActivity(
				input({ pageUrl: placeholder.pageUrl }),
			),
		).resolves.toEqual({ kept: true });

		for (const row of [cancelled, placeholder]) {
			expect(row).toMatchObject({
				extractionStatus: "FAILED",
				extractionError: REASON,
			});
		}
	});

	it("leaves a PENDING or FAILED page that holds vectors as it is, and keeps it", async () => {
		const pending = seedIndexedPage({ extractionStatus: "PENDING" });
		const failed = seedIndexedPage({
			id: "page-3",
			pageUrl: `${PAGE_URL}/failed`,
			extractionStatus: "FAILED",
			extractionError: "Embedding provider timed out",
		});
		const before = [{ ...pending }, { ...failed }];

		for (const row of [pending, failed]) {
			await expect(
				recordUrlPageFetchFailureActivity(
					input({ pageUrl: row.pageUrl }),
				),
			).resolves.toEqual({ kept: true });
		}

		expect([pending, failed]).toEqual(before);
	});

	it("creates a FAILED row with no content and the parent's ids for a URL it has no row for", async () => {
		await expect(
			recordUrlPageFetchFailureActivity(input()),
		).resolves.toEqual({ kept: true });

		expect(h.urlPage.create).toHaveBeenCalledOnce();
		expect(h.urlPage.create.mock.calls[0][0].data).toEqual({
			parentContextId: "ctx-1",
			projectId: "proj-1",
			pageUrl: PAGE_URL,
			content: "",
			contentHash: "",
			extractionStatus: "FAILED",
			extractionError: REASON,
			userId: "user-1",
			organizationId: "org-a",
		});
	});

	// Removed here, not left to the prune: a crawl that fetched no page
	// deletes nothing.
	it("removes the empty row of a URL refused for good, and does not keep it", async () => {
		const placeholder = seedPlaceholder();

		await expect(
			recordUrlPageFetchFailureActivity(input({ permanent: true })),
		).resolves.toEqual({ kept: false });
		await expect(
			recordUrlPageFetchFailureActivity(
				input({ pageUrl: placeholder.pageUrl, permanent: true }),
			),
		).resolves.toEqual({ kept: false });

		expect(h.urlPage.create).not.toHaveBeenCalled();
		expect(h.urlPage.updateMany).not.toHaveBeenCalled();
		expect(h.rows).not.toContain(placeholder);
	});

	it("marks and keeps an indexed page on a permanent failure too", async () => {
		const page = seedIndexedPage();

		await expect(
			recordUrlPageFetchFailureActivity(input({ permanent: true })),
		).resolves.toEqual({ kept: true });

		expect(page).toMatchObject({
			extractionStatus: "FAILED",
			extractionError: REASON,
			embeddedAt: EMBEDDED_AT,
		});
	});

	it("finds the page under its own parent only", async () => {
		const other = seedIndexedPage({
			id: "page-x",
			parentContextId: "ctx-2",
		});
		const before = { ...other };

		await recordUrlPageFetchFailureActivity(input());

		expect(other).toEqual(before);
		expect(h.urlPage.findFirst.mock.calls[0][0].where).toEqual({
			parentContextId: "ctx-1",
			pageUrl: PAGE_URL,
		});
		expect(h.urlPage.create.mock.calls[0][0].data).toMatchObject({
			parentContextId: "ctx-1",
		});
	});

	it("records an empty cause as an unknown error rather than a bare prefix", async () => {
		const page = seedIndexedPage();

		await recordUrlPageFetchFailureActivity(input({ reason: "  " }));

		expect(page.extractionError).toBe(
			`${URL_PAGE_FETCH_FAILURE_PREFIX}unknown error`,
		);
	});

	it("leaves the same state when the same failure is recorded twice", async () => {
		seedIndexedPage();
		seedPlaceholder({ extractionStatus: "CANCELLED" });

		const record = async () => {
			await recordUrlPageFetchFailureActivity(input());
			await recordUrlPageFetchFailureActivity(
				input({ pageUrl: `${PAGE_URL}/placeholder` }),
			);
			await recordUrlPageFetchFailureActivity(
				input({ pageUrl: `${PAGE_URL}/new` }),
			);
		};
		await record();
		const once = structuredClone(h.rows);
		await record();

		expect(h.rows).toEqual(once);
	});

	it("never reaches the company vector store", async () => {
		seedIndexedPage();

		await recordUrlPageFetchFailureActivity(input());

		expect(resolveCompanyEmbeddingModel).not.toHaveBeenCalled();
		expect(deleteCompanyContextRowPoints).not.toHaveBeenCalled();
	});

	it("lets a database failure through, so Temporal retries the activity", async () => {
		h.urlPage.findFirst.mockRejectedValueOnce(
			new Error("connection reset"),
		);

		await expect(
			recordUrlPageFetchFailureActivity(input()),
		).rejects.toThrow("connection reset");
	});
});
