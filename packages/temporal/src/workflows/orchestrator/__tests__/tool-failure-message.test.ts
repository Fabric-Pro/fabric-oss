/**
 * What a chat user reads when the loop's three-strike breaker stops a turn,
 * and the code-index states that should never reach that breaker
 * (Fizzy #2578).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codeIndexUnavailableResult } from "../../../activities/direct-chat/code-search-repositories";
import { formatToolFailureAbort } from "../tool-failure-message";

describe("formatToolFailureAbort", () => {
	it("reads as a sentence to the user, not a log line", () => {
		expect(
			formatToolFailureAbort("code_search", "Search backend timed out."),
		).toBe(
			"I couldn't complete this: `code_search` kept failing (Search backend timed out). Try again, or ask differently.",
		);
	});

	it("caps a long error and folds its whitespace", () => {
		const message = formatToolFailureAbort(
			"jira_search",
			`first line\n\n${"x".repeat(1000)}`,
		);
		expect(message).toContain("(first line xxx");
		expect(message.length).toBeLessThan(420);
		expect(message).not.toContain("\n");
	});

	it("still reads cleanly with no error text", () => {
		expect(formatToolFailureAbort("code_tree", "  ")).toBe(
			"I couldn't complete this: `code_tree` kept failing. Try again, or ask differently.",
		);
	});

	it("replaces the operator wording on the breaker path", () => {
		const loop = readFileSync(
			join(
				process.cwd(),
				"src/workflows/orchestrator/phases/iterative-execution.ts",
			),
			"utf-8",
		);
		expect(loop).toMatch(
			/error: formatToolFailureAbort\(\s*toolCall\.name,\s*toolError,?\s*\),/,
		);
		expect(loop).not.toContain("aborting iteration loop. Last error");
	});
});

describe("codeIndexUnavailableResult", () => {
	it.each([
		["INDEXING", "is still building"],
		["PENDING", "is still building"],
		["FAILED", "failed to build"],
		["missing", "no repository has been indexed"],
		["STALE", "is not searchable right now (status STALE)"],
	])("%s says %s, as a plain result", (status, phrase) => {
		const result = codeIndexUnavailableResult(status);
		expect(result).toMatchObject({ available: false, status, results: [] });
		expect(result.message).toContain(phrase);
		expect(result.message).toContain("code search is unavailable for now");
		expect(result).not.toHaveProperty("error");
		expect(result).not.toHaveProperty("success");
	});

	it("names the repository when one was asked for", () => {
		expect(
			codeIndexUnavailableResult("INDEXING", "example-org/web").message,
		).toMatch(/^The code index for example-org\/web is still building/);
	});
});
