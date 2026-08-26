import { describe, expect, it } from "vitest";
import { parseTicketIds } from "./parse-ticket-ids";

describe("parseTicketIds", () => {
	describe("happy path", () => {
		it("expands '417, 419-425' per AC-7", () => {
			const result = parseTicketIds("417, 419-425");
			expect(result).toEqual({
				ok: true,
				ids: [417, 419, 420, 421, 422, 423, 424, 425],
			});
		});

		it("accepts a single ID", () => {
			expect(parseTicketIds("42")).toEqual({ ok: true, ids: [42] });
		});

		it("accepts multiple comma-separated IDs", () => {
			expect(parseTicketIds("1,2,3")).toEqual({
				ok: true,
				ids: [1, 2, 3],
			});
		});

		it("tolerates whitespace around tokens and hyphens", () => {
			const result = parseTicketIds("  417 ,   419 - 421 ");
			expect(result).toEqual({ ok: true, ids: [417, 419, 420, 421] });
		});

		it("accepts newline-separated tokens", () => {
			const result = parseTicketIds("1\n2\n3-5");
			expect(result).toEqual({ ok: true, ids: [1, 2, 3, 4, 5] });
		});

		it("dedupes overlapping ranges and repeated IDs", () => {
			const result = parseTicketIds("5, 1-3, 2, 3");
			expect(result).toEqual({ ok: true, ids: [1, 2, 3, 5] });
		});

		it("treats equal-bound ranges as a single ID", () => {
			expect(parseTicketIds("7-7")).toEqual({ ok: true, ids: [7] });
		});

		it("allows exactly 200 expanded IDs", () => {
			const result = parseTicketIds("1-200");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.ids.length).toBe(200);
				expect(result.ids[0]).toBe(1);
				expect(result.ids[199]).toBe(200);
			}
		});
	});

	describe("not_numeric", () => {
		it("rejects 'abc'", () => {
			const result = parseTicketIds("abc");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors).toEqual([
					{ kind: "not_numeric", token: "abc" },
				]);
			}
		});

		it("rejects '41a' (trailing letters)", () => {
			const result = parseTicketIds("41a");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors[0]).toMatchObject({ kind: "not_numeric" });
			}
		});

		it("rejects 'PROJ-123' (non-numeric range half)", () => {
			const result = parseTicketIds("PROJ-123");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors[0]).toMatchObject({ kind: "not_numeric" });
			}
		});

		it("rejects a range with missing side '1-'", () => {
			const result = parseTicketIds("1-");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors[0]).toMatchObject({ kind: "not_numeric" });
			}
		});
	});

	describe("range_inversion", () => {
		it("rejects '5-2' per AC-7", () => {
			const result = parseTicketIds("5-2");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors).toEqual([
					{ kind: "range_inversion", token: "5-2" },
				]);
			}
		});
	});

	describe("over_cap", () => {
		it("rejects a range that expands to 201 IDs", () => {
			const result = parseTicketIds("1-201");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(
					result.errors.some((error) => error.kind === "over_cap"),
				).toBe(true);
			}
		});

		it("rejects when combined tokens cross the cap", () => {
			const result = parseTicketIds("1-150, 140-250");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(
					result.errors.some((error) => error.kind === "over_cap"),
				).toBe(true);
			}
		});
	});

	describe("empty tokens are silently ignored", () => {
		it("ignores a trailing comma", () => {
			const result = parseTicketIds("1,");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.ids).toEqual([1]);
			}
		});

		it("ignores a leading comma", () => {
			const result = parseTicketIds(",1");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.ids).toEqual([1]);
			}
		});

		it("ignores empty tokens between commas", () => {
			const result = parseTicketIds("1,,2");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.ids).toEqual([1, 2]);
			}
		});

		it("ignores whitespace-only tokens between commas", () => {
			const result = parseTicketIds("1,   ,2");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.ids).toEqual([1, 2]);
			}
		});
	});

	it("accumulates multiple errors in a single pass", () => {
		const result = parseTicketIds("abc, 5-2, ,41a");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const kinds = result.errors.map((error) => error.kind).sort();
			expect(kinds).toContain("not_numeric");
			expect(kinds).toContain("range_inversion");
		}
	});
});
