/**
 * Spec 2026-05-21-roadmap-unique-sequential-ticket-ids — Group 3.
 *
 * Pure-function test for the legacy-prefix stripper used at every server-side
 * and client-side identifier-search call site (`listStories`,
 * `searchStoriesProcedure`, `applyRoadmapFilters`). Anchored regex MUST NOT
 * strip prefixes from substrings inside non-identifier text (`feature-...`
 * stays `feature-...`); matching is case-insensitive; the function is
 * idempotent.
 *
 * No database access — runs unconditionally on every test pass.
 */

import { describe, expect, it } from "vitest";
import { normalizeStoryIdentifierQuery } from "../prisma/queries/projects/stories";

describe("normalizeStoryIdentifierQuery (spec 2026-05-21 Group 3)", () => {
	describe("strips legacy uppercase prefixes", () => {
		it("strips `B-` from `B-011`", () => {
			expect(normalizeStoryIdentifierQuery("B-011")).toBe("011");
		});

		it("strips `F-` from `F-12`", () => {
			expect(normalizeStoryIdentifierQuery("F-12")).toBe("12");
		});

		it("strips `US-` from `US-7`", () => {
			expect(normalizeStoryIdentifierQuery("US-7")).toBe("7");
		});

		it("strips `TASK-` from `TASK-3`", () => {
			expect(normalizeStoryIdentifierQuery("TASK-3")).toBe("3");
		});
	});

	describe("is case-insensitive", () => {
		it("strips `b-` from `b-011`", () => {
			expect(normalizeStoryIdentifierQuery("b-011")).toBe("011");
		});

		it("strips `f-` from `f-12`", () => {
			expect(normalizeStoryIdentifierQuery("f-12")).toBe("12");
		});

		it("strips `us-` from `us-7`", () => {
			expect(normalizeStoryIdentifierQuery("us-7")).toBe("7");
		});

		it("strips `task-` from `task-3`", () => {
			expect(normalizeStoryIdentifierQuery("task-3")).toBe("3");
		});

		it("handles mixed-case `Us-` and `tAsK-`", () => {
			expect(normalizeStoryIdentifierQuery("Us-42")).toBe("42");
			expect(normalizeStoryIdentifierQuery("tAsK-99")).toBe("99");
		});
	});

	describe("leaves non-prefixed input alone", () => {
		it("returns plain numeric input as-is", () => {
			expect(normalizeStoryIdentifierQuery("11")).toBe("11");
		});

		it("returns multi-digit numeric input as-is", () => {
			expect(normalizeStoryIdentifierQuery("1042")).toBe("1042");
		});

		it("returns empty string as-is", () => {
			expect(normalizeStoryIdentifierQuery("")).toBe("");
		});
	});

	describe("anchored regex does not strip non-prefix matches", () => {
		// This is the load-bearing assertion: a substring match anywhere
		// inside the input must NOT trigger a prefix strip. The leading `^`
		// in the regex is the guard.
		it("does not strip `F-` from `feature-something`", () => {
			expect(normalizeStoryIdentifierQuery("feature-something")).toBe(
				"feature-something",
			);
		});

		it("does not strip `b-` from `bug-report`", () => {
			expect(normalizeStoryIdentifierQuery("bug-report")).toBe(
				"bug-report",
			);
		});

		it("does not strip a prefix that appears mid-string", () => {
			expect(normalizeStoryIdentifierQuery("foo F-12")).toBe("foo F-12");
			expect(normalizeStoryIdentifierQuery("xF-12")).toBe("xF-12");
		});

		it("does not strip a prefix from `US-7` when preceded by whitespace", () => {
			expect(normalizeStoryIdentifierQuery(" US-7")).toBe(" US-7");
		});
	});

	describe("idempotency", () => {
		const cases = [
			"B-011",
			"b-011",
			"F-12",
			"f-12",
			"US-7",
			"TASK-3",
			"task-3",
			"11",
			"feature-something",
			"",
			"foo F-12",
			"Us-42",
		];

		for (const input of cases) {
			it(`normalize(normalize(${JSON.stringify(input)})) === normalize(${JSON.stringify(input)})`, () => {
				const once = normalizeStoryIdentifierQuery(input);
				const twice = normalizeStoryIdentifierQuery(once);
				expect(twice).toBe(once);
			});
		}
	});
});
