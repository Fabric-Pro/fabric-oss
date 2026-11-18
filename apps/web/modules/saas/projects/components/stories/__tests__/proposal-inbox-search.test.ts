/**
 * Proposal Inbox search: a query keeps a row when its summary, or the title or
 * identifier of any of its items, contains the query, ignoring case. The query
 * is literal text, never a regular expression.
 */

import { describe, expect, it } from "vitest";
import {
	filterProposalsByQuery,
	normalizeProposalQuery,
	proposalMatchesQuery,
} from "../proposal-inbox-search";

const ROWS = [
	{
		id: "a",
		summary: "Export improvements from the planning call",
		items: [
			{ title: "Rate limit the export endpoint", identifier: null },
			{ title: "Export throttling", identifier: "F-12" },
		],
	},
	{
		id: "b",
		summary: "Login follow-ups",
		items: [{ title: "Session refresh (beta)", identifier: "B-7" }],
	},
	{ id: "c", summary: "A row from an older list payload" },
];

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

describe("proposal inbox search", () => {
	it("keeps every row, in order, for a blank query", () => {
		expect(ids(filterProposalsByQuery(ROWS, ""))).toEqual(["a", "b", "c"]);
		expect(ids(filterProposalsByQuery(ROWS, "   "))).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	it("matches the summary ignoring case", () => {
		expect(ids(filterProposalsByQuery(ROWS, "LOGIN"))).toEqual(["b"]);
	});

	it("keeps a row whose summary does not match but one item's title does", () => {
		expect(ids(filterProposalsByQuery(ROWS, "rate limit"))).toEqual(["a"]);
	});

	it("keeps a row whose item identifier matches", () => {
		expect(ids(filterProposalsByQuery(ROWS, "f-12"))).toEqual(["a"]);
		expect(ids(filterProposalsByQuery(ROWS, "B-7"))).toEqual(["b"]);
	});

	it.each([
		["(beta)", ["b"]],
		["(", ["b"]],
		["*", []],
		["[", []],
		[".*", []],
		["\\", []],
	])("treats %s as literal text without throwing", (query, expected) => {
		expect(ids(filterProposalsByQuery(ROWS, query))).toEqual(expected);
	});

	it("finds nothing for a query no row contains", () => {
		expect(filterProposalsByQuery(ROWS, "no such text")).toEqual([]);
	});

	it("trims and lower-cases the query once", () => {
		expect(normalizeProposalQuery("  Export ")).toBe("export");
		expect(
			proposalMatchesQuery(
				{ summary: "x", items: [{ title: "y", identifier: null }] },
				"z",
			),
		).toBe(false);
	});
});
