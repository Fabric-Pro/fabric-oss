/** Static determinism checks; command compatibility is exercised by offline replay. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
	fileURLToPath(new URL("../story-sync-workflow.ts", import.meta.url)),
	"utf8",
);

/** Strip block + line comments so doc-comment mentions of the tokens don't false-fail. */
function stripComments(code: string): string {
	return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("storySyncWorkflow determinism", () => {
	const code = stripComments(SOURCE);

	it("uses no wall-clock in the workflow body", () => {
		expect(code).not.toMatch(/\bDate\.now\s*\(/);
		expect(code).not.toMatch(/\bnew\s+Date\s*\(/);
		expect(code).not.toMatch(/\bMath\.random\s*\(/);
	});

	it("gates the new command-producing logic behind patched('bulk-sync-conflict-detection-v2')", () => {
		expect(code).toContain('patched("bulk-sync-conflict-detection-v2")');
	});

	it("gates the claimed create behind patched('bulk-sync-create-claim-v1')", () => {
		expect(code).toContain('patched("bulk-sync-create-claim-v1")');
	});
	it("gates link validation behind patched('bulk-sync-link-guard-v1')", () => {
		expect(code).toContain('patched("bulk-sync-link-guard-v1")');
	});
});
