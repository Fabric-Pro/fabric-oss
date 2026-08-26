import { describe, expect, it } from "vitest";
import {
	PM_TITLE_LIMITS,
	truncateTitleForProvider,
} from "../src/activities/pm-integration/pm-title-limits";

const FIZZY_LIMIT = 255;

describe("PM_TITLE_LIMITS", () => {
	it("caps Fizzy titles at 255 (verified against the live Fizzy API: 255→201, 256→500)", () => {
		expect(PM_TITLE_LIMITS.fizzy).toBe(255);
	});
});

describe("truncateTitleForProvider", () => {
	it("leaves a title that is exactly at the limit unchanged", () => {
		const title = "a".repeat(FIZZY_LIMIT);
		const out = truncateTitleForProvider(title, "fizzy");
		expect(out).toBe(title);
		expect(Array.from(out)).toHaveLength(FIZZY_LIMIT);
	});

	it("truncates a title one char over the limit to exactly the limit, with an ellipsis", () => {
		const title = "a".repeat(FIZZY_LIMIT + 1);
		const out = truncateTitleForProvider(title, "fizzy");
		expect(Array.from(out).length).toBeLessThanOrEqual(FIZZY_LIMIT);
		expect(out.endsWith("…")).toBe(true);
	});

	it("truncates the real 257-char story #245 title (the production failure) below the limit", () => {
		const title =
			"As a Fabric developer, I want all legacy type-checking, linting, and formatting errors fixed across the repository in a single sweeping effort, so that PR validation hooks run on a clean codebase and future code strictly adheres to CONTRIBUTING.md standards";
		expect(title.length).toBe(257);
		const out = truncateTitleForProvider(title, "fizzy");
		expect(Array.from(out).length).toBeLessThanOrEqual(FIZZY_LIMIT);
		expect(out.endsWith("…")).toBe(true);
		// Prefix is preserved up to the cut.
		expect(out.startsWith("As a Fabric developer")).toBe(true);
	});

	it("leaves a short title untouched", () => {
		const title = "Short and sweet";
		expect(truncateTitleForProvider(title, "fizzy")).toBe(title);
	});

	it("does not touch tools without a configured limit", () => {
		const title = "z".repeat(500);
		expect(truncateTitleForProvider(title, "jira")).toBe(title);
		expect(truncateTitleForProvider(title, "github")).toBe(title);
	});

	it("is case-insensitive on the detected type", () => {
		const title = "a".repeat(FIZZY_LIMIT + 10);
		expect(
			Array.from(truncateTitleForProvider(title, "FIZZY")).length,
		).toBe(FIZZY_LIMIT);
	});

	it("returns the title unchanged for null/undefined/empty detected type", () => {
		const title = "q".repeat(500);
		expect(truncateTitleForProvider(title, null)).toBe(title);
		expect(truncateTitleForProvider(title, undefined)).toBe(title);
		expect(truncateTitleForProvider(title, "")).toBe(title);
	});

	it("never splits a multi-byte code point at the boundary", () => {
		// 254 ASCII chars followed by emoji (each emoji is 1 code point but 2
		// UTF-16 units) — truncation must slice on code-point boundaries so the
		// surrogate pair is never cut in half, and stay within the char budget.
		const title = `${"a".repeat(254)}${"😀".repeat(10)}`;
		const out = truncateTitleForProvider(title, "fizzy");
		expect(Array.from(out).length).toBeLessThanOrEqual(FIZZY_LIMIT);
		// No lone surrogate (a split emoji would leave U+FFFD or a half-pair).
		expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
		expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
	});

	it("trims trailing whitespace before appending the ellipsis", () => {
		const title = `${"word ".repeat(60)}`; // 300 chars, space-heavy
		const out = truncateTitleForProvider(title, "fizzy");
		expect(out.endsWith(" …")).toBe(false);
		expect(out.endsWith("…")).toBe(true);
		expect(Array.from(out).length).toBeLessThanOrEqual(FIZZY_LIMIT);
	});
});
