/**
 * `listProjectContextSummaries` / `getCrawledUrlSourceMarkdown` query-layer
 * tests.
 *
 * Both back the MCP project-context tools, and both make promises that only
 * show up in the Prisma call args: the inventory never selects `content` (a
 * few hundred meeting transcripts would otherwise stream tens of megabytes
 * for a listing), it drops repository code-index rows unless asked, an
 * explicit `type` overrides that default, and `hasContent` is resolved with
 * id-only follow-ups — including the child-page check a PATH_PREFIX URL
 * source needs, since its markdown never lands on the parent row.
 *
 * DB-free: the Prisma client is mocked and the assertions are on call args.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { contextFindMany, contextCount, urlPageFindMany, rawQuery } = vi.hoisted(
	() => ({
		contextFindMany: vi.fn(),
		contextCount: vi.fn(),
		urlPageFindMany: vi.fn(),
		rawQuery: vi.fn(),
	}),
);

vi.mock("../prisma/client", () => ({
	db: {
		projectContext: {
			findMany: (...args: unknown[]) => contextFindMany(...args),
			count: (...args: unknown[]) => contextCount(...args),
		},
		projectContextUrlPage: {
			findMany: (...args: unknown[]) => urlPageFindMany(...args),
		},
		$queryRaw: (...args: unknown[]) => rawQuery(...args),
	},
	Prisma: { join: (values: unknown[]) => ({ __join: values }) },
}));

/** Flatten a tagged-template call into its SQL text, params substituted as `?`. */
function sqlOf(call: unknown[]): string {
	return (call[0] as string[]).join("?").replace(/\s+/g, " ").trim();
}

/** The interpolated values of a tagged-template call. */
function paramsOf(call: unknown[]): unknown[] {
	return call.slice(1);
}

import {
	getCrawledUrlSourceMarkdown,
	listProjectContextSummaries,
} from "../prisma/queries/projects/contexts";

/** One row as the lean inventory select returns it. */
function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "ctx-1",
		type: "MEETING_TRANSCRIPT",
		sourceTitle: "Weekly sync",
		originalFilename: null,
		mimeType: null,
		fileSize: null,
		sourceUrl: null,
		extractionStatus: "COMPLETED",
		urlScope: null,
		metadata: null,
		createdAt: new Date("2026-08-01T09:00:00Z"),
		updatedAt: new Date("2026-08-01T09:00:00Z"),
		s3Path: null,
		...overrides,
	};
}

/**
 * The inventory issues one `findMany` for the page and then raw statements for
 * the readable-text resolution. Implementations are set rather than queued with
 * `mockResolvedValueOnce`, because `vi.clearAllMocks()` clears recorded calls
 * but keeps a queued `Once` — an unconsumed one leaks into the next test.
 */
function stubFindMany(page: unknown[], withContent: Array<{ id: string }>) {
	contextFindMany.mockImplementation(() => Promise.resolve(page));
	rawQuery.mockImplementation((strings: string[]) =>
		Promise.resolve(
			strings.join("").includes("project_context_url_page")
				? []
				: withContent,
		),
	);
}

/** Return the given counts in call order (page total, then hidden code rows). */
function stubCounts(...values: number[]) {
	let call = 0;
	contextCount.mockImplementation(() =>
		Promise.resolve(values[Math.min(call++, values.length - 1)]),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	stubFindMany([], []);
	stubCounts(0);
	urlPageFindMany.mockResolvedValue([]);
});

describe("listProjectContextSummaries", () => {
	it("never selects the bodies", async () => {
		stubFindMany([], []);

		await listProjectContextSummaries({ projectId: "proj-1" });

		const select = contextFindMany.mock.calls[0][0].select;
		expect(select.content).toBeUndefined();
		expect(select).toMatchObject({ id: true, type: true, s3Path: true });
	});

	it("excludes repository code-index rows by default and counts what it hid", async () => {
		stubFindMany([], []);
		stubCounts(4, 1200);

		const result = await listProjectContextSummaries({
			projectId: "proj-1",
		});

		expect(contextFindMany.mock.calls[0][0].where).toEqual({
			projectId: "proj-1",
			type: { notIn: ["CODE_FILE", "CODE_FILE_SUMMARY"] },
		});
		expect(result.excludedCodeContexts).toBe(1200);
	});

	it("keeps code-index rows when the caller opts in", async () => {
		stubFindMany([], []);

		const result = await listProjectContextSummaries({
			projectId: "proj-1",
			includeCodeContexts: true,
		});

		expect(contextFindMany.mock.calls[0][0].where).toEqual({
			projectId: "proj-1",
		});
		expect(result.excludedCodeContexts).toBe(0);
	});

	it("lets an explicit type win over the code-index default", async () => {
		stubFindMany([], []);

		await listProjectContextSummaries({
			projectId: "proj-1",
			type: "CODE_FILE",
		});

		expect(contextFindMany.mock.calls[0][0].where).toEqual({
			projectId: "proj-1",
			type: "CODE_FILE",
		});
	});

	it("marks a row with stored text as readable, and an empty one as not", async () => {
		stubFindMany(
			[row({ id: "ctx-full" }), row({ id: "ctx-empty" })],
			[{ id: "ctx-full" }],
		);
		stubCounts(2);

		const result = await listProjectContextSummaries({
			projectId: "proj-1",
		});

		const sql = sqlOf(rawQuery.mock.calls[0]);
		expect(sql).toContain("FROM project_context");
		expect(sql).toContain("SELECT id");
		expect(paramsOf(rawQuery.mock.calls[0])[0]).toEqual({
			__join: ["ctx-full", "ctx-empty"],
		});
		expect(result.contexts.map((c) => c.hasContent)).toEqual([true, false]);
	});

	it("treats whitespace-only extraction as nothing to read", async () => {
		// A scanned or photo-only PDF completes extraction and stores "\n\n".
		// `content <> ''` would call that readable and hand the caller two
		// newlines, so the predicate has to test for a non-whitespace character.
		// Postgres `btrim` defaults to spaces only and would NOT catch it.
		stubFindMany([row()], []);
		stubCounts(1);

		await listProjectContextSummaries({ projectId: "proj-1" });

		const call = rawQuery.mock.calls[0];
		expect(sqlOf(call)).toContain("content ~");
		expect(paramsOf(call)).toContain("[^[:space:]]");
		expect(sqlOf(call)).not.toContain("btrim");
	});

	it("credits a crawled URL source for the text on its child pages", async () => {
		contextFindMany.mockResolvedValue([
			row({ id: "ctx-link", urlScope: "PATH_PREFIX" }),
		]);
		rawQuery.mockImplementation((strings: string[]) =>
			Promise.resolve(
				strings.join("").includes("project_context_url_page")
					? [{ parentContextId: "ctx-link" }]
					: [],
			),
		);
		stubCounts(1);

		const result = await listProjectContextSummaries({
			projectId: "proj-1",
		});

		const child = rawQuery.mock.calls.find((c) =>
			sqlOf(c).includes("project_context_url_page"),
		);
		expect(child).toBeDefined();
		expect(sqlOf(child as unknown[])).toContain("content ~");
		expect(result.contexts[0].hasContent).toBe(true);
	});

	it("skips the child-page statement when nothing was crawled", async () => {
		stubFindMany([row()], []);
		stubCounts(1);

		await listProjectContextSummaries({ projectId: "proj-1" });

		expect(
			rawQuery.mock.calls.filter((c) =>
				sqlOf(c).includes("project_context_url_page"),
			),
		).toHaveLength(0);
	});

	it("reports hasMore off the rows actually returned", async () => {
		stubFindMany([row()], []);
		stubCounts(30);

		const result = await listProjectContextSummaries({
			projectId: "proj-1",
			limit: 1,
			offset: 10,
		});

		expect(result).toMatchObject({ total: 30, hasMore: true });
		expect(contextFindMany.mock.calls[0][0]).toMatchObject({
			take: 1,
			skip: 10,
		});
	});
});

describe("getCrawledUrlSourceMarkdown", () => {
	it("scopes child pages to the caller's organization", async () => {
		await getCrawledUrlSourceMarkdown("ctx-link", {
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(urlPageFindMany.mock.calls[0][0].where).toEqual({
			parentContextId: "ctx-link",
			organizationId: "org-1",
		});
	});

	it("scopes personal-context child pages to the owner", async () => {
		await getCrawledUrlSourceMarkdown("ctx-link", {
			userId: "user-1",
			organizationId: null,
		});

		expect(urlPageFindMany.mock.calls[0][0].where).toEqual({
			parentContextId: "ctx-link",
			organizationId: null,
			userId: "user-1",
		});
	});

	it("joins pages in pageUrl order and drops the empty ones", async () => {
		urlPageFindMany.mockResolvedValue([
			{
				pageUrl: "https://example.com/a",
				pageTitle: "Install",
				content: "Run it.",
			},
			{
				pageUrl: "https://example.com/b",
				pageTitle: null,
				content: "",
			},
			{
				pageUrl: "https://example.com/c",
				pageTitle: null,
				content: "Deploy it.",
			},
		]);

		const markdown = await getCrawledUrlSourceMarkdown("ctx-link", {
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(urlPageFindMany.mock.calls[0][0].orderBy).toEqual({
			pageUrl: "asc",
		});
		expect(markdown).toBe(
			"## Install\nhttps://example.com/a\n\nRun it.\n" +
				"\n---\n\n" +
				"## https://example.com/c\nhttps://example.com/c\n\nDeploy it.\n",
		);
	});
});
