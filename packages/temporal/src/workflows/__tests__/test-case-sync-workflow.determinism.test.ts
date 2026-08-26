/**
 * Determinism guard for `testCaseSyncWorkflow`.
 *
 * Temporal workflows must be deterministic for replay: no wall-clock
 * (`Date.now()`, `new Date()`), no `Math.random()`. Timestamps are stamped
 * inside activities; the only `Date.now()` for the workflowId lives at the API
 * start-site, not the workflow body. This is a static source scan (comments
 * stripped) — a cheap proxy for the full replay validation, which needs a
 * running Temporal.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test test-case-sync-workflow.determinism
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
	fileURLToPath(new URL("../test-case-sync-workflow.ts", import.meta.url)),
	"utf8",
);

/** Strip block + line comments so doc-comment mentions of the tokens don't false-fail. */
function stripComments(code: string): string {
	return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("testCaseSyncWorkflow determinism", () => {
	const code = stripComments(SOURCE);

	it("uses no wall-clock in the workflow body", () => {
		expect(code).not.toMatch(/\bDate\.now\s*\(/);
		expect(code).not.toMatch(/\bnew\s+Date\s*\(/);
		expect(code).not.toMatch(/\bMath\.random\s*\(/);
	});

	it("gates the new command-producing logic behind patched('test-case-sync-v1')", () => {
		expect(code).toContain('patched("test-case-sync-v1")');
	});
});
