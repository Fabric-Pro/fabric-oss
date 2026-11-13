import { describe, expect, it, vi } from "vitest";
import {
	deploymentRecordsParameter,
	MAX_DATED_LIST_PAGES,
	MAX_PLAIN_LIST_PAGES,
	MAX_SEARCH_PAGES,
	MAX_SEARCH_WINDOWS,
	periodTextStart,
	readFullPages,
	readToolResultPages,
	reportPeriodParameter,
	reportPeriodStart,
	reportSettingsPromptLines,
	searchResultPage,
	slimCommit,
	slimPullRequest,
	splitSearchDateRange,
	takesPageArgument,
} from "../report-plain-list-pages";
import { computePullRequestFacts } from "../report-pull-request-facts";

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

	it("caps a search at GitHub's result limit and says more is left", async () => {
		const paged = await readToolResultPages({
			output: search(100, 5000),
			args: { perPage: 100 },
			inputSchema: pagedSchema,
			fetchPage: vi.fn().mockResolvedValue(search(100, 5000)),
			beat: () => {},
		});

		expect(paged.read?.pages).toBe(MAX_SEARCH_PAGES);
		expect(paged.read?.stoppedEarly).toContain("full pages");
	});

	it("splits a search's date range at its middle day, later half first", () => {
		expect(
			splitSearchDateRange({
				query: "is:merged merged:2026-08-07..2026-11-07",
				perPage: 100,
				page: 10,
			}),
		).toEqual([
			{
				query: "is:merged merged:2026-09-23..2026-11-07",
				perPage: 100,
				page: 1,
			},
			{
				query: "is:merged merged:2026-08-07..2026-09-22",
				perPage: 100,
				page: 1,
			},
		]);
		expect(splitSearchDateRange({ query: "is:merged" })).toBeNull();
		expect(
			splitSearchDateRange({ q: "merged:2026-08-07..2026-08-07" }),
		).toBeNull();
	});

	it("reads a search past GitHub's 1,000-result limit in narrower date ranges, each match once", async () => {
		// GitHub answers at most 10 pages of 100 for one query.
		const ranges: Record<string, { total: number; from: number }> = {
			"2026-08-07..2026-11-07": { total: 1020, from: 0 },
			"2026-09-23..2026-11-07": { total: 600, from: 0 },
			"2026-08-07..2026-09-22": { total: 420, from: 600 },
		};
		const fetchPage = vi.fn(
			async ({ query, page }: Record<string, unknown>) => {
				const range = String(query).split("merged:")[1] ?? "";
				const { total, from } = ranges[range] ?? { total: 0, from: 0 };
				const start = (Number(page) - 1) * 100;
				const count = Math.max(0, Math.min(100, total - start));
				return search(count, total, from + start);
			},
		);

		const paged = await readToolResultPages({
			output: search(100, 1020),
			args: {
				query: "is:merged merged:2026-08-07..2026-11-07",
				perPage: 100,
			},
			inputSchema: pagedSchema,
			fetchPage,
			beat: () => {},
		});

		const output = Array.isArray(paged.output) ? paged.output : [];
		expect(output).toHaveLength(1020);
		expect(new Set(output.map((item) => item.number)).size).toBe(1020);
		expect(paged.read?.windows).toBe(2);
		expect(paged.read?.total).toBe(1020);
		expect(paged.read?.stoppedEarly).toBeUndefined();
		// Every call, the caller's first one included.
		expect(paged.read?.pages).toBe(fetchPage.mock.calls.length + 1);
	});

	it("stops splitting a search after the window limit and says more is left", async () => {
		const fetchPage = vi.fn().mockResolvedValue(search(100, 50_000));

		const paged = await readToolResultPages({
			output: search(100, 50_000),
			args: { query: "merged:2026-01-01..2026-12-31", perPage: 100 },
			inputSchema: pagedSchema,
			fetchPage,
			beat: () => {},
		});

		expect(paged.read?.windows).toBeLessThanOrEqual(MAX_SEARCH_WINDOWS);
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

describe("deploymentRecordsParameter", () => {
	it("reads the place the person named, and nothing when it is blank", () => {
		expect(
			deploymentRecordsParameter({
				deploymentRecords: " commits to deploy/ledger.json ",
			}),
		).toBe("commits to deploy/ledger.json");
		expect(deploymentRecordsParameter({ deploymentRecords: " " })).toBe(
			undefined,
		);
		expect(deploymentRecordsParameter({})).toBe(undefined);
	});
});

describe("reportSettingsPromptLines", () => {
	it("states the period with its start, and where deployments are recorded", () => {
		const lines = reportSettingsPromptLines({
			reportPeriod: {
				text: "Last 3 months",
				start: Date.parse("2026-08-06T00:00:00.000Z"),
			},
			deploymentRecords: "commits to deploy/ledger.json",
		});

		expect(lines).toContain("## Report Period");
		expect(lines).toContain(
			"The report covers `Last 3 months`, from 2026-08-06 (UTC). When a tool can filter or search by date, ask for this period.",
		);
		expect(lines).toContain("## Deployment Records");
		expect(lines.join("\n")).toContain(
			"deployments are recorded in: `commits to deploy/ledger.json`. Read these records for the whole period",
		);
	});

	it("adds nothing for settings that are not set", () => {
		expect(reportSettingsPromptLines({})).toEqual([]);
	});
});

describe("commit history", () => {
	const DAY = 86_400_000;
	const now = Date.parse("2026-11-07T00:00:00.000Z");
	const pagedSchema = { properties: { page: { type: "number" } } };
	const PERIOD_DAYS = 92;
	const IN_PERIOD = 2045;
	// Newest first, 2,045 commits across the period, in GitHub's shape.
	const commits = (count: number, from: number) =>
		Array.from({ length: count }, (_, i) => ({
			sha: `sha-${from + i}`,
			html_url: `https://github.com/example-org/example/commit/${from + i}`,
			commit: {
				message: `Change ${from + i}\n\n${"Squashed description. ".repeat(80)}`,
				author: {
					name: "Example Dev",
					email: "dev@example.com",
					date: new Date(
						now - ((from + i) * PERIOD_DAYS * DAY) / IN_PERIOD,
					).toISOString(),
				},
				committer: { name: "GitHub", email: "noreply@example.com" },
				tree: { sha: "tree", url: "https://api.example.com/tree" },
			},
			author: {
				login: "example-dev",
				avatar_url: "https://example.com/a",
			},
			committer: { login: "web-flow" },
			parents: [{ sha: "parent" }],
		}));

	it("keeps a commit's hash, subject line, author and date", () => {
		expect(slimCommit(commits(1, 0)[0])).toEqual({
			sha: "sha-0",
			commit: {
				message: "Change 0",
				author: {
					name: "Example Dev",
					date: "2026-11-07T00:00:00.000Z",
				},
			},
			author: { login: "example-dev" },
		});
	});

	it("leaves anything that is not a commit as it came", () => {
		const pullRequest = { number: 7, title: "Example", sha: "abc" };

		expect(slimCommit(pullRequest)).toBe(pullRequest);
		expect(slimCommit("text")).toBe("text");
	});

	it("reads all 21 pages of three months of commits, slim", async () => {
		const periodStart = now - PERIOD_DAYS * DAY;
		const fetchPage = vi.fn(async ({ page }: Record<string, unknown>) => {
			const from = (Number(page) - 1) * 100;
			return commits(Math.min(100, IN_PERIOD - from), from);
		});

		const paged = await readToolResultPages({
			output: commits(100, 0),
			args: { owner: "example-org", repo: "example", perPage: 100 },
			inputSchema: pagedSchema,
			fetchPage,
			beat: () => {},
			periodStart,
		});

		expect(paged.read?.pages).toBe(21);
		expect(paged.read?.stoppedEarly).toBeUndefined();
		expect(paged.output).toEqual(
			commits(IN_PERIOD, 0).map((commit) => slimCommit(commit)),
		);
		expect(JSON.stringify(paged.output).length).toBeLessThan(
			JSON.stringify(commits(IN_PERIOD, 0)).length / 10,
		);
	});
});

describe("pull requests", () => {
	const now = new Date("2026-11-07T00:00:00.000Z");
	const person = (login: string) => ({
		login,
		id: 1,
		avatar_url: "https://example.com/a",
		url: "https://api.example.com/users/x",
	});
	// One page of a GitHub issue search for merged pull requests.
	const searchItems = (count: number, from: number) =>
		Array.from({ length: count }, (_, i) => {
			const number = from + i + 1;
			const merged = now.getTime() - number * 3_600_000;
			return {
				url: `https://api.example.com/issues/${number}`,
				html_url: `https://github.com/example-org/example/pull/${number}`,
				id: 10_000 + number,
				node_id: `PR_${number}`,
				number,
				title:
					number % 250 === 0
						? `Revert change ${number}`
						: `Change ${number}`,
				user: person("example-dev"),
				labels: [{ id: 1, name: "bug", color: "red", url: "u" }],
				state: "closed",
				assignees: [person("example-reviewer")],
				milestone: null,
				comments: 2,
				created_at: new Date(merged - 20 * 60_000).toISOString(),
				updated_at: new Date(merged).toISOString(),
				closed_at: new Date(merged).toISOString(),
				draft: false,
				pull_request: {
					url: "u",
					diff_url: "d",
					merged_at: new Date(merged).toISOString(),
				},
				body: "A long pull request description. ".repeat(100),
				reactions: { url: "r", total_count: 0 },
			};
		});

	it("keeps what a report reads and the start of the description", () => {
		const [item] = searchItems(1, 0);

		expect(slimPullRequest(item)).toEqual({
			number: 1,
			title: "Change 1",
			state: "closed",
			draft: false,
			created_at: item.created_at,
			updated_at: item.updated_at,
			closed_at: item.closed_at,
			html_url: "https://github.com/example-org/example/pull/1",
			comments: 2,
			pull_request: { merged_at: item.pull_request.merged_at },
			body: `${item.body.slice(0, 280)}…`,
			user: { login: "example-dev" },
			assignees: [{ login: "example-reviewer" }],
			labels: [{ name: "bug" }],
		});
	});

	it("keeps a listed pull request's branches and merge date", () => {
		const listed = {
			number: 3,
			title: "Change",
			html_url: "https://github.com/example-org/example/pull/3",
			merged_at: "2026-11-01T00:00:00Z",
			base: { ref: "staging", sha: "s", repo: { full_name: "x" } },
			head: { ref: "fix/example", sha: "h", repo: { full_name: "x" } },
		};

		expect(slimPullRequest(listed)).toEqual({
			number: 3,
			title: "Change",
			html_url: "https://github.com/example-org/example/pull/3",
			merged_at: "2026-11-01T00:00:00Z",
			base: { ref: "staging" },
			head: { ref: "fix/example" },
		});
	});

	it("leaves anything that is not an issue or pull request as it came", () => {
		const release = {
			tag_name: "v1.0.0",
			html_url: "https://github.com/example-org/example/releases/tag/v1",
		};
		const card = { number: 4, title: "Card", url: "https://example.com/4" };

		expect(slimPullRequest(release)).toBe(release);
		expect(slimPullRequest(card)).toBe(card);
	});

	it("reads a search of 1,022 merged pull requests slim, with the same facts", async () => {
		const all = searchItems(1022, 0);
		const fetchPage = vi.fn(async ({ page }: Record<string, unknown>) => ({
			total_count: 1022,
			items: all.slice((Number(page) - 1) * 100, Number(page) * 100),
		}));

		const paged = await readToolResultPages({
			output: { total_count: 1022, items: all.slice(0, 100) },
			args: { query: "is:pr is:merged", perPage: 100 },
			inputSchema: { properties: { page: { type: "number" } } },
			fetchPage,
			beat: () => {},
		});

		const output = Array.isArray(paged.output) ? paged.output : [];
		expect(output).toHaveLength(1000);
		expect(computePullRequestFacts(output, undefined, now)).toEqual(
			computePullRequestFacts(all.slice(0, 1000), undefined, now),
		);
		expect(JSON.stringify(output).length).toBeLessThan(
			JSON.stringify(all.slice(0, 1000)).length / 3,
		);
	});
});
