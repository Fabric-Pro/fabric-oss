import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaMismatchDetail } from "../schema-mismatch-detail";

describe("schemaMismatchDetail", () => {
	it("lists each Zod issue's path and message, never the value", () => {
		const parsed = z
			.object({ tags: z.array(z.string()), note: z.string() })
			.safeParse({ tags: null, note: "secret draft text", extra: 1 });
		const error = { cause: { cause: parsed.error } };
		const detail = schemaMismatchDetail(error);
		expect(detail).toBe(
			" [tags: Invalid input: expected array, received null]",
		);
		expect(detail).not.toContain("secret");
	});

	it("caps a long list", () => {
		const issues = Array.from({ length: 12 }, (_, i) => ({
			path: ["options", i, "label"],
			message: "Too big",
		}));
		expect(schemaMismatchDetail({ issues })).toMatch(
			/^ \[options\.0\.label: Too big;.*options\.9\.label: Too big; \+2 more\]$/,
		);
	});

	it("is empty when there is nothing to name", () => {
		expect(schemaMismatchDetail(new Error("boom"))).toBe("");
		expect(schemaMismatchDetail(undefined)).toBe("");
		expect(schemaMismatchDetail({ issues: [] })).toBe("");
	});
});
