/**
 * The filter and paging shared by a project's `listUrlPages` and its company
 * context twin. Both lists spread `urlPageListFilter` after their own scope
 * and page their `limit + 1` read through `urlPageListPage`, so a change here
 * reaches both — these tests pin what the two answer.
 */
import { describe, expect, it } from "vitest";
import { urlPageListFilter, urlPageListPage } from "../url-page-listing";

describe("urlPageListFilter", () => {
	it("adds nothing for every status and no search", () => {
		expect(urlPageListFilter({ statusFilter: "all" })).toEqual({});
		expect(
			urlPageListFilter({ statusFilter: "all", search: "   " }),
		).toEqual({});
	});

	it("expands each status bucket to its statuses", () => {
		expect(urlPageListFilter({ statusFilter: "indexed" })).toEqual({
			extractionStatus: { in: ["COMPLETED"] },
		});
		expect(urlPageListFilter({ statusFilter: "processing" })).toEqual({
			extractionStatus: { in: ["PENDING", "EXTRACTING"] },
		});
		expect(urlPageListFilter({ statusFilter: "failed" })).toEqual({
			extractionStatus: { in: ["FAILED"] },
		});
	});

	it("searches the title or the URL, case-insensitively, with the search trimmed", () => {
		expect(
			urlPageListFilter({ statusFilter: "failed", search: "  pricing " }),
		).toEqual({
			extractionStatus: { in: ["FAILED"] },
			OR: [
				{ pageTitle: { contains: "pricing", mode: "insensitive" } },
				{ pageUrl: { contains: "pricing", mode: "insensitive" } },
			],
		});
	});
});

describe("urlPageListPage", () => {
	const rows = (count: number) =>
		Array.from({ length: count }, (_, i) => ({ id: `p${i + 1}` }));

	it("drops the extra row and points the cursor at the last row returned", () => {
		expect(urlPageListPage(rows(3), 2)).toEqual({
			items: [{ id: "p1" }, { id: "p2" }],
			nextCursor: "p2",
			hasNext: true,
		});
	});

	it("has no next page when the read came back at or under the limit", () => {
		expect(urlPageListPage(rows(2), 2)).toEqual({
			items: [{ id: "p1" }, { id: "p2" }],
			nextCursor: null,
			hasNext: false,
		});
		expect(urlPageListPage([], 2)).toEqual({
			items: [],
			nextCursor: null,
			hasNext: false,
		});
	});

	it("keeps each row as the caller selected it", () => {
		const selected = [
			{ id: "p1", pageUrl: "https://example.com/a" },
			{ id: "p2", pageUrl: "https://example.com/b" },
		];

		expect(urlPageListPage(selected, 1).items).toEqual([selected[0]]);
	});
});
