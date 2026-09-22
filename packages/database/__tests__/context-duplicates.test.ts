/**
 * `annotateDuplicateContexts` — which context rows are copies of another row's
 * content, and which row each one is a copy of (Fizzy #2619).
 *
 * What this pins:
 *  - a hash seen once is not a duplicate; rows with no hash are never grouped;
 *  - the row kept is a synced file (`sourcePath` set) when there is one, then
 *    the earliest `createdAt`, then the smallest id — so the choice is stable
 *    and never depends on the order the rows arrived in;
 *  - every extra copy in a group points at the same kept row, and the kept row
 *    itself is never marked.
 *
 * Run with: pnpm --filter @repo/database test -- __tests__/context-duplicates.test.ts
 */

import { describe, expect, it } from "vitest";
import { annotateDuplicateContexts } from "../prisma/queries/projects/context-duplicates";

type Row = {
	id: string;
	contentHash: string | null;
	sourcePath: string | null;
	createdAt: Date | string;
};

function row(
	id: string,
	contentHash: string | null,
	createdAt: string,
	sourcePath: string | null = null,
): Row {
	return { id, contentHash, sourcePath, createdAt: new Date(createdAt) };
}

describe("annotateDuplicateContexts", () => {
	it("does not flag a row whose hash appears once", () => {
		const result = annotateDuplicateContexts([
			row("a", "h1", "2026-01-01T00:00:00Z"),
			row("b", "h2", "2026-01-02T00:00:00Z"),
		]);
		expect(result.size).toBe(0);
	});

	it("never groups rows that carry no hash", () => {
		const result = annotateDuplicateContexts([
			row("a", null, "2026-01-01T00:00:00Z"),
			row("b", null, "2026-01-02T00:00:00Z"),
			row("c", "", "2026-01-03T00:00:00Z"),
			row("d", "", "2026-01-04T00:00:00Z"),
		]);
		expect(result.size).toBe(0);
	});

	it("keeps the earliest row and points the later copy at it", () => {
		const result = annotateDuplicateContexts([
			row("later", "h1", "2026-03-01T00:00:00Z"),
			row("earlier", "h1", "2026-01-01T00:00:00Z"),
		]);
		expect(Object.fromEntries(result)).toEqual({ later: "earlier" });
	});

	it("prefers a synced file over an older manual upload", () => {
		const result = annotateDuplicateContexts([
			row("upload", "h1", "2026-01-01T00:00:00Z"),
			row("synced", "h1", "2026-06-01T00:00:00Z", "docs/readme.md"),
		]);
		expect(Object.fromEntries(result)).toEqual({ upload: "synced" });
	});

	it("breaks a createdAt tie on the smallest id, whatever the input order", () => {
		const createdAt = "2026-01-01T00:00:00Z";
		const forward = annotateDuplicateContexts([
			row("ctx-a", "h1", createdAt),
			row("ctx-b", "h1", createdAt),
		]);
		const reversed = annotateDuplicateContexts([
			row("ctx-b", "h1", createdAt),
			row("ctx-a", "h1", createdAt),
		]);
		expect(Object.fromEntries(forward)).toEqual({ "ctx-b": "ctx-a" });
		expect(Object.fromEntries(reversed)).toEqual({ "ctx-b": "ctx-a" });
	});

	it("points both extras of a three-way duplicate at the same kept row", () => {
		const result = annotateDuplicateContexts([
			row("third", "h1", "2026-01-03T00:00:00Z"),
			row("first", "h1", "2026-01-01T00:00:00Z"),
			row("second", "h1", "2026-01-02T00:00:00Z"),
			row("other", "h2", "2026-01-01T00:00:00Z"),
		]);
		expect(Object.fromEntries(result)).toEqual({
			second: "first",
			third: "first",
		});
		expect(result.has("first")).toBe(false);
		expect(result.has("other")).toBe(false);
	});

	it("accepts serialized createdAt strings", () => {
		const result = annotateDuplicateContexts([
			{
				id: "b",
				contentHash: "h1",
				sourcePath: null,
				createdAt: "2026-02-01T00:00:00.000Z",
			},
			{
				id: "a",
				contentHash: "h1",
				sourcePath: null,
				createdAt: "2026-03-01T00:00:00.000Z",
			},
		]);
		expect(Object.fromEntries(result)).toEqual({ a: "b" });
	});
});
