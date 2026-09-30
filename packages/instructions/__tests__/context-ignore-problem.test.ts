/**
 * The `.contextignore` rule check (Fizzy #2784): a rule with more `**` groups
 * than `ignore` can evaluate in bounded time is reported with its line, and
 * never handed to the matcher.
 */
import { MAX_CONTEXT_SOURCE_PATH_LENGTH } from "@repo/database/prisma/queries/projects/context-source-path";
import ignore from "ignore";
import { describe, expect, it } from "vitest";
import {
	findContextIgnoreProblem,
	MAX_CONTEXT_IGNORE_DOUBLE_STAR_GROUPS,
} from "../src/context-sync-rules";

/** The deepest path a sync can store: one-character segments to the storage-key cap. */
const DEEPEST_PATH = "a/".repeat(MAX_CONTEXT_SOURCE_PATH_LENGTH / 2);
const BUDGET_MS = 50;

/** A rule with `groups` `**` groups, each followed by an `a` segment, ending in `c`. */
const rule = (groups: number) => `${"**/a/".repeat(groups)}c`;

function timed<T>(run: () => T): { result: T; elapsed: number } {
	const start = performance.now();
	const result = run();
	return { result, elapsed: performance.now() - start };
}

describe("findContextIgnoreProblem", () => {
	it("returns the adversarial rule's problem, with its line, in under 50 ms", () => {
		const text = `# policy\n\ndrafts/\n${rule(MAX_CONTEXT_IGNORE_DOUBLE_STAR_GROUPS + 3)}\n`;

		const { result, elapsed } = timed(() => findContextIgnoreProblem(text));

		expect(result).toEqual({
			kind: "too-many-double-stars",
			line: 4,
			groups: MAX_CONTEXT_IGNORE_DOUBLE_STAR_GROUPS + 3,
			max: MAX_CONTEXT_IGNORE_DOUBLE_STAR_GROUPS,
		});
		expect(elapsed).toBeLessThan(BUDGET_MS);
	});

	it("checks a 64 KiB file in under 50 ms", () => {
		const text = `${"docs/**/notes.md\n".repeat(4_000)}${rule(9)}\n`;

		const { result, elapsed } = timed(() => findContextIgnoreProblem(text));

		expect(result).toMatchObject({ line: 4_001 });
		expect(elapsed).toBeLessThan(BUDGET_MS);
	});

	it("still evaluates a cap-sized rule within budget at the deepest stored path", () => {
		const capSized = rule(MAX_CONTEXT_IGNORE_DOUBLE_STAR_GROUPS);
		expect(findContextIgnoreProblem(capSized)).toBeNull();

		const matcher = ignore({ ignorecase: true }).add(capSized);
		const { result, elapsed } = timed(() => matcher.ignores(DEEPEST_PATH));

		expect(result).toBe(false);
		expect(elapsed).toBeLessThan(BUDGET_MS);
	});

	it.each([
		["the usual node_modules rule", "**/node_modules/**"],
		["a folder rule with two groups", "docs/**/drafts/**"],
		["a plain rule", "drafts/"],
		["many single stars", "*/*/*/*/*/*/*/*/c"],
		["an empty file", ""],
	])("accepts %s", (_name, text) => {
		expect(findContextIgnoreProblem(text)).toBeNull();
	});

	it("counts groups per rule, not per file", () => {
		const text = ["**/a/**", "**/b/**", "**/c/**", "**/d/**"].join("\n");

		expect(findContextIgnoreProblem(text)).toBeNull();
	});

	it.each([
		["a run of stars as one group", "a/****/b/**/c/**", 3],
		["a negation, which is compiled like any rule", "!**/a/**/b/**", 3],
		["an indented rule", "  **/a/**/b/**", 3],
	])("rejects %s", (_name, text, groups) => {
		expect(findContextIgnoreProblem(text)).toMatchObject({
			line: 1,
			groups,
		});
	});

	it("does not read a comment as a rule, and numbers lines across CRLF", () => {
		const text = "# **/a/**/b/**/c/**\r\n\r\ndocs/\r\n**/a/**/b/**\r\n";

		expect(findContextIgnoreProblem(text)).toMatchObject({ line: 4 });
		expect(
			findContextIgnoreProblem("# **/a/**/b/**/c/**\r\ndocs/\r\n"),
		).toBeNull();
	});

	it("names the first offending rule", () => {
		const text = `${rule(3)}\n${rule(5)}\n`;

		expect(findContextIgnoreProblem(text)).toMatchObject({
			line: 1,
			groups: 3,
		});
	});

	it("keeps the cap at two, the largest count measured to stay within budget", () => {
		expect(MAX_CONTEXT_IGNORE_DOUBLE_STAR_GROUPS).toBe(2);
	});
});
