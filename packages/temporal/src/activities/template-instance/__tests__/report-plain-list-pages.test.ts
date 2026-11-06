import { describe, expect, it, vi } from "vitest";
import {
	MAX_DATED_LIST_PAGES,
	MAX_PLAIN_LIST_PAGES,
	periodTextStart,
	readFullPages,
	readToolResultPages,
	reportPeriodParameter,
	reportPeriodStart,
	searchResultPage,
	takesPageArgument,
} from "../report-plain-list-pages";

const items = (count: number, from = 0) =>
	Array.from({ length: count }, (_, i) => ({ number: from + i }));

describe("takesPageArgument", () => {
	it("is true for a numeric page, bare or wrapped by the AI SDK", () => {
		const schema = { properties: { page: { type: "number" } } };

		expect(takesPageArgument(schema)).toBe(true);
		expect(takesPageArgument({ jsonSchema: schema })).toBe(true);
		expect(
			takesPageArgument({
				properties: { page: { type: ["integer", "null"] } },
			}),
		).toBe(true);
	});

	it("is false without a numeric page", () => {
		expect(
			takesPageArgument({ properties: { page: { type: "string" } } }),
		).toBe(false);
		expect(
			takesPageArgument({ properties: { state: { type: "string" } } }),
		).toBe(false);
		expect(takesPageArgument(undefined)).toBe(false);
	});
});

describe("readFullPages", () => {
	it("reads on while pages are full and stops at a short one", async () => {
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce(items(100, 100))
			.mockResolvedValueOnce(items(40, 200));

		const read = await readFullPages({
			args: { owner: "example-org", perPage: 100 },
			firstPage: items(100),
			fetchPage,
			beat: () => {},
		});

		expect(read.pages).toBe(3);
		expect(read.items).toHaveLength(240);
		expect(read.stoppedEarly).toBeUndefined();
		expect(fetchPage.mock.calls.map(([args]) => args.page)).toEqual([2, 3]);
		expect(fetchPage.mock.calls[0][0]).toMatchObject({
			owner: "example-org",
			perPage: 100,
		});
	});

	it("reads nothing more when the first page is short", async () => {
		const fetchPage = vi.fn();

		const read = await readFullPages({
			args: { perPage: 100 },
			firstPage: items(82),
			fetchPage,
			beat: () => {},
		});

		expect(read).toEqual({ items: items(82), startPage: 1, pages: 1 });
		expect(fetchPage).not.toHaveBeenCalled();
	});

	it("takes a round first page as full when no page size was asked for", async () => {
		const fetchPage = vi.fn().mockResolvedValueOnce([]);

		const read = await readFullPages({
			args: {},
			firstPage: items(30),
			fetchPage,
			beat: () => {},
		});

		expect(fetchPage).toHaveBeenCalledTimes(1);
		expect(read.items).toHaveLength(30);
		expect(read.pages).toBe(2);
	});

	it("does not page a list whose page size cannot be known", async () => {
		const fetchPage = vi.fn();

		await readFullPages({
			args: {},
			firstPage: items(42),
			fetchPage,
			beat: () => {},
		});

		expect(fetchPage).not.toHaveBeenCalled();
	});

	it("starts after the page the model asked for", async () => {
		const fetchPage = vi.fn().mockResolvedValueOnce(items(10));

		await readFullPages({
			args: { page: 2, per_page: 50 },
			firstPage: items(50),
			fetchPage,
			beat: () => {},
		});

		expect(fetchPage.mock.calls[0][0].page).toBe(3);
	});

	it("reports the page it started from", async () => {
		const read = await readFullPages({
			args: { page: 4, perPage: 100 },
			firstPage: items(100),
			fetchPage: vi.fn().mockResolvedValue(items(100)),
			beat: () => {},
		});

		expect(read.startPage).toBe(4);
		expect(read.pages).toBe(MAX_PLAIN_LIST_PAGES);
	});

	it("takes a full page at the source's limit when more was asked for", async () => {
		const fetchPage = vi.fn().mockResolvedValueOnce(items(20));

		const read = await readFullPages({
			args: { perPage: 250 },
			firstPage: items(100),
			fetchPage,
			beat: () => {},
		});

		expect(fetchPage).toHaveBeenCalledTimes(1);
		expect(read.items).toHaveLength(120);
	});

	it("keeps a requested size the source honoured", async () => {
		const fetchPage = vi.fn();

		await readFullPages({
			args: { perPage: 100 },
			firstPage: items(50),
			fetchPage,
			beat: () => {},
		});

		expect(fetchPage).not.toHaveBeenCalled();
	});

	it("stops at the page cap and says more may be left", async () => {
		const fetchPage = vi.fn().mockResolvedValue(items(100));

		const read = await readFullPages({
			args: { perPage: 100 },
			firstPage: items(100),
			fetchPage,
			beat: () => {},
		});

		expect(read.pages).toBe(MAX_PLAIN_LIST_PAGES);
		expect(fetchPage).toHaveBeenCalledTimes(MAX_PLAIN_LIST_PAGES - 1);
		expect(read.stoppedEarly).toContain(
			`${MAX_PLAIN_LIST_PAGES} full pages`,
		);
	});

	it("keeps what it read when a later page fails", async () => {
		const fetchPage = vi
			.fn()
			.mockRejectedValueOnce(new Error("rate limited"));

		const read = await readFullPages({
			args: { perPage: 100 },
			firstPage: items(100),
			fetchPage,
			beat: () => {},
		});

		expect(read.items).toHaveLength(100);
		expect(read.pages).toBe(1);
		expect(read.stoppedEarly).toBe(
			"page 2 could not be read: rate limited",
		);
	});

	it("stops when a later page is not a list", async () => {
		const fetchPage = vi.fn().mockResolvedValueOnce({ error: "not found" });

		const read = await readFullPages({
			args: { perPage: 100 },
			firstPage: items(100),
			fetchPage,
			beat: () => {},
		});

		expect(read).toEqual({ items: items(100), startPage: 1, pages: 1 });
	});

	it("keeps the activity alive before each page", async () => {
		const beat = vi.fn();

		await readFullPages({
			args: { perPage: 100 },
			firstPage: items(100),
			fetchPage: vi.fn().mockResolvedValue(items(5)),
			beat,
		});

		expect(beat).toHaveBeenCalledTimes(1);
	});
});

describe("readFullPages with a report period", () => {
	const DAY = 86_400_000;
	const now = Date.parse("2026-11-06T00:00:00.000Z");
	// Newest first, one item a day, as a repository lists pull requests.
	const dated = (count: number, daysAgo: number) =>
		Array.from({ length: count }, (_, i) => ({
			number: daysAgo + i,
			created_at: new Date(now - (daysAgo + i) * DAY).toISOString(),
		}));

	it("reads past the plain cap until a page reaches back before the period", async () => {
		const periodStart = now - 450 * DAY;
		const fetchPage = vi.fn(async ({ page }: Record<string, unknown>) =>
			dated(100, (Number(page) - 1) * 100),
		);

		const read = await readFullPages({
			args: { perPage: 100 },
			firstPage: dated(100, 0),
			fetchPage,
			beat: () => {},
			periodStart,
		});

		expect(read.pages).toBe(5);
		expect(read.stoppedEarly).toBeUndefined();
		expect(read.pages).toBeGreaterThan(MAX_PLAIN_LIST_PAGES);
	});

	it("reads no more when the first page already reaches back before the period", async () => {
		const fetchPage = vi.fn();

		const read = await readFullPages({
			args: { perPage: 100 },
			firstPage: dated(100, 0),
			fetchPage,
			beat: () => {},
			periodStart: now - 30 * DAY,
		});

		expect(read.pages).toBe(1);
		expect(fetchPage).not.toHaveBeenCalled();
	});

	it("dates a commit by its author date", async () => {
		const commits = (from: number) =>
			Array.from({ length: 100 }, (_, i) => ({
				sha: `example-${from + i}`,
				commit: {
					author: {
						date: new Date(now - (from + i) * DAY).toISOString(),
					},
				},
			}));
		const fetchPage = vi.fn().mockResolvedValueOnce(commits(100));

		const read = await readFullPages({
			args: { perPage: 100 },
			firstPage: commits(0),
			fetchPage,
			beat: () => {},
			periodStart: now - 150 * DAY,
		});

		expect(read.pages).toBe(2);
	});

	it("does not cut a list sorted oldest first", async () => {
		// Oldest first: the first page ends long before the period starts.
		const oldestFirst = (count: number, daysAgo: number) =>
			dated(count, daysAgo).reverse();
		const fetchPage = vi.fn().mockResolvedValue(oldestFirst(100, 300));

		const read = await readFullPages({
			args: { perPage: 100 },
			firstPage: oldestFirst(100, 400),
			fetchPage,
			beat: () => {},
			periodStart: now - 90 * DAY,
		});

		expect(fetchPage).toHaveBeenCalled();
		expect(read.pages).toBe(MAX_PLAIN_LIST_PAGES);
	});

	it("keeps the plain cap for a list with no dates", async () => {
		const read = await readFullPages({
			args: { perPage: 100 },
			firstPage: items(100),
			fetchPage: vi.fn().mockResolvedValue(items(100)),
			beat: () => {},
			periodStart: now - 365 * DAY,
		});

		expect(read.pages).toBe(MAX_PLAIN_LIST_PAGES);
	});

	it("stops at the dated cap for a list that never reaches the period", async () => {
		const read = await readFullPages({
			args: { perPage: 100 },
			firstPage: dated(100, 0),
			fetchPage: vi.fn().mockResolvedValue(dated(100, 0)),
			beat: () => {},
			periodStart: now - 10_000 * DAY,
		});

		expect(read.pages).toBe(MAX_DATED_LIST_PAGES);
		expect(read.stoppedEarly).toContain(
			`${MAX_DATED_LIST_PAGES} full pages`,
		);
	});
});

describe("reportPeriodStart", () => {
	it("takes the earlier of the period and its comparison", () => {
		const context = {
			evidenceWindow: JSON.stringify({
				start: "2026-08-06T00:00:00.000Z",
				end: "2026-11-06T00:00:00.000Z",
				comparison: {
					start: "2026-05-06T00:00:00.000Z",
					end: "2026-08-06T00:00:00.000Z",
				},
			}),
		};

		expect(reportPeriodStart(context)).toBe(
			Date.parse("2026-05-06T00:00:00.000Z"),
		);
	});

	it("is undefined without a readable window, so a period parameter decides", () => {
		expect(reportPeriodStart({})).toBeUndefined();
		expect(
			reportPeriodStart({ evidenceWindow: "not json" }),
		).toBeUndefined();
		expect(reportPeriodStart({ evidenceWindow: "{}" })).toBeUndefined();
	});
});

describe("reportPeriodParameter", () => {
	it("takes the first non-empty text parameter named for a period", () => {
		expect(
			reportPeriodParameter({
				projectName: "Example",
				reportPeriod: " Last 3 months ",
				comparisonPeriod: "Last 6 months",
			}),
		).toBe("Last 3 months");
	});

	it("is undefined without one", () => {
		expect(
			reportPeriodParameter({ projectName: "Example" }),
		).toBeUndefined();
		expect(reportPeriodParameter({ reportPeriod: "  " })).toBeUndefined();
		expect(
			reportPeriodParameter({
				reportEvidenceWindow: { start: "2026-08-06" },
			}),
		).toBeUndefined();
	});
});

describe("periodTextStart", () => {
	// A Friday.
	const now = Date.parse("2026-11-06T02:00:00.000Z");
	const day = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`);

	it.each([
		["Last 3 months", "2026-08-06"],
		["Last 2 weeks", "2026-10-23"],
		["Last 7 days", "2026-10-30"],
		["Last 30 days", "2026-10-07"],
		["past 1 year", "2025-11-06"],
		["This week", "2026-11-02"],
		["Last week", "2026-10-26"],
		["This month", "2026-11-01"],
		["Last month", "2026-10-01"],
		["This quarter", "2026-10-01"],
		["Last quarter", "2026-07-01"],
		["This year", "2026-01-01"],
		["March 2026", "2026-03-01"],
		["2026-08-01 to 2026-10-31", "2026-08-01"],
	])("dates %s from %s", (text, start) => {
		expect(periodTextStart(text, now)).toBe(day(start));
	});

	it("takes the month's last day when the day does not exist", () => {
		expect(
			periodTextStart(
				"Last 3 months",
				Date.parse("2026-05-31T09:00:00Z"),
			),
		).toBe(day("2026-02-28"));
	});

	it.each(["Sprint 42", "Current Sprint", "Smarch 2026", "", undefined])(
		"is undefined for %s",
		(text) => {
			expect(periodTextStart(text, now)).toBeUndefined();
		},
	);
});

describe("readToolResultPages", () => {
	const pagedSchema = { properties: { page: { type: "number" } } };
	const search = (count: number, total: number, from = 0) => ({
		total_count: total,
		incomplete_results: false,
		items: items(count, from),
	});

	it("reads a plain list past its first page", async () => {
		const fetchPage = vi.fn().mockResolvedValueOnce(items(10, 100));

		const paged = await readToolResultPages({
			output: items(100),
			args: { perPage: 100 },
			inputSchema: pagedSchema,
			fetchPage,
			beat: () => {},
		});

		expect(paged.output).toHaveLength(110);
		expect(paged.read?.pages).toBe(2);
	});

	it("knows a search reply only by its items and match count", () => {
		expect(searchResultPage(search(2, 2))).toEqual({
			items: items(2),
			total: 2,
		});
		expect(searchResultPage(items(2))).toBeNull();
		expect(searchResultPage({ items: items(2) })).toBeNull();
	});

	it("reads a search up to its match count and returns its items as a plain list", async () => {
		const fetchPage = vi.fn(async ({ page }: Record<string, unknown>) =>
			search(Number(page) < 8 ? 100 : 17, 717, (Number(page) - 1) * 100),
		);

		const paged = await readToolResultPages({
			output: search(100, 717),
			args: { query: "is:pr is:merged", perPage: 100 },
			inputSchema: pagedSchema,
			fetchPage,
			beat: () => {},
		});

		expect(fetchPage).toHaveBeenCalledTimes(7);
		// A bare list, so the gathered-data budget can shorten it.
		expect(Array.isArray(paged.output)).toBe(true);
		expect(paged.output).toHaveLength(717);
		expect(paged.read?.total).toBe(717);
		expect(paged.read?.stoppedEarly).toBeUndefined();
	});

	it("stops a search once it holds every match, without asking for an empty page", async () => {
		const fetchPage = vi.fn().mockResolvedValueOnce(search(100, 200, 100));

		await readToolResultPages({
			output: search(100, 200),
			args: { perPage: 100 },
			inputSchema: pagedSchema,
			fetchPage,
			beat: () => {},
		});

		expect(fetchPage).toHaveBeenCalledTimes(1);
	});

	it("caps a search at the dated page limit and says more is left", async () => {
		const paged = await readToolResultPages({
			output: search(100, 5000),
			args: { perPage: 100 },
			inputSchema: pagedSchema,
			fetchPage: vi.fn().mockResolvedValue(search(100, 5000)),
			beat: () => {},
		});

		expect(paged.read?.pages).toBe(MAX_DATED_LIST_PAGES);
		expect(paged.read?.stoppedEarly).toContain("full pages");
	});

	it("returns any other output, or any tool without a page argument, as it came", async () => {
		const fetchPage = vi.fn();
		const object = { name: "example" };

		expect(
			await readToolResultPages({
				output: object,
				args: {},
				inputSchema: pagedSchema,
				fetchPage,
				beat: () => {},
			}),
		).toEqual({ output: object });
		expect(
			await readToolResultPages({
				output: items(100),
				args: { perPage: 100 },
				inputSchema: { properties: {} },
				fetchPage,
				beat: () => {},
			}),
		).toEqual({ output: items(100) });
		expect(fetchPage).not.toHaveBeenCalled();
	});
});
