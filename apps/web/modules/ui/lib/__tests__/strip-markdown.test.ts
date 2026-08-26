import { describe, expect, it } from "vitest";
import { stripMarkdown } from "../strip-markdown";

describe("stripMarkdown", () => {
	// Covers AC3: raw Markdown tokens are not visible in previews.
	it("strips bold markers", () => {
		expect(stripMarkdown("**Steps to Reproduce**")).toBe(
			"Steps to Reproduce",
		);
	});

	it("strips ATX heading markers", () => {
		expect(stripMarkdown("## Overview")).toBe("Overview");
	});

	it("strips unordered list markers", () => {
		expect(stripMarkdown("- item one")).toBe("item one");
	});

	it("strips ordered list markers", () => {
		expect(stripMarkdown("1. first")).toBe("first");
	});

	it("reduces a link to its label", () => {
		expect(stripMarkdown("see [docs](https://example.com)")).toBe(
			"see docs",
		);
	});

	it("collapses a pipe table row to spaced cells", () => {
		const out = stripMarkdown("| a | b |");
		expect(out).not.toContain("|");
		expect(out).toBe("a b");
	});

	it("drops a table separator row and joins content", () => {
		const table = "| a | b |\n| - | - |\n| 1 | 2 |";
		const out = stripMarkdown(table);
		expect(out).not.toContain("|");
		expect(out).toContain("a b");
		expect(out).toContain("1 2");
	});

	it("strips inline code backticks", () => {
		expect(stripMarkdown("run `pnpm test` now")).toBe("run pnpm test now");
	});

	it("strips fenced code block fences, keeping the inner text", () => {
		const out = stripMarkdown("```ts\nconst x = 1;\n```");
		expect(out).not.toContain("```");
		expect(out).toContain("const x = 1;");
	});

	it("reduces an image to its alt text", () => {
		expect(stripMarkdown("before ![diagram](http://x/y.png) after")).toBe(
			"before diagram after",
		);
	});

	it("strips strikethrough markers", () => {
		expect(stripMarkdown("~~gone~~ kept")).toBe("gone kept");
	});

	it("strips blockquote markers", () => {
		expect(stripMarkdown("> quoted line")).toBe("quoted line");
	});

	it("leaves plain text unchanged", () => {
		expect(stripMarkdown("just plain text")).toBe("just plain text");
	});

	it("collapses newlines and whitespace to single spaces", () => {
		expect(stripMarkdown("**a**\n\n## b\n- c")).toBe("a b c");
	});

	it("returns empty string for empty or nullish input", () => {
		expect(stripMarkdown("")).toBe("");
		expect(stripMarkdown(null)).toBe("");
		expect(stripMarkdown(undefined)).toBe("");
		expect(stripMarkdown("   \n  ")).toBe("");
	});

	it("does not throw on unbalanced markers and leaves no stray **", () => {
		expect(() => stripMarkdown("**unclosed bold")).not.toThrow();
		expect(stripMarkdown("**unclosed bold")).not.toContain("**");
	});

	// Regression: CommonMark forbids intraword underscores as emphasis, so
	// snake_case identifiers must survive intact (Bug: AI_UPDATE_SIDEBAR was
	// mangled to AIUPDATESIDEBAR by a naive `_..._` strip).
	it("preserves snake_case identifiers (single intraword underscores)", () => {
		expect(stripMarkdown("Epic proposal from AI_UPDATE_SIDEBAR")).toBe(
			"Epic proposal from AI_UPDATE_SIDEBAR",
		);
		expect(stripMarkdown("user_id and order_total")).toBe(
			"user_id and order_total",
		);
	});

	it("still strips underscore emphasis at word boundaries", () => {
		expect(stripMarkdown("_italic_ text")).toBe("italic text");
		expect(stripMarkdown("__bold__ text")).toBe("bold text");
	});

	// Regression: a large body of stray underscores must not blow up into
	// quadratic rescans (`summary` is unbounded @db.Text, stripped on the main
	// thread). The single-LINE case is the important one — bounding the
	// underscore regex to a line does not help there, only the input cap does.
	it("handles a large single-line body of stray underscores without blowing up", () => {
		const pathological = "_a ".repeat(50000); // ~150KB, no newlines
		const start = performance.now();
		const out = stripMarkdown(pathological);
		expect(performance.now() - start).toBeLessThan(200);
		expect(typeof out).toBe("string");
	});

	it("handles a large multi-line body of stray underscores without blowing up", () => {
		const pathological = "_a\n".repeat(50000);
		const start = performance.now();
		const out = stripMarkdown(pathological);
		expect(performance.now() - start).toBeLessThan(200);
		expect(typeof out).toBe("string");
	});

	it("caps input length so cost is constant regardless of payload size", () => {
		const out = stripMarkdown(`${"a".repeat(10000)} tail`);
		expect(out.length).toBeLessThanOrEqual(4000);
	});
});
