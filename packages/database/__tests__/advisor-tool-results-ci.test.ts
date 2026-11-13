import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
	new URL("../../../.github/workflows/db-integration.yml", import.meta.url),
	"utf8",
);
const guard = source
	.split("Guard: assert the Advisor result-store suite executed")[1]
	?.match(/node <<'EOF'\n([\s\S]*?)\n\s+EOF/)?.[1]
	.split("\n")
	.map((line) => line.replace(/^ {10}/, ""))
	.join("\n");
const valid = {
	testResults: [{}],
	numTotalTests: 41,
	numPassedTests: 41,
	numSkippedTests: 0,
	numPendingTests: 0,
	numFailedTests: 0,
};
function runGuard(report: unknown) {
	const cwd = mkdtempSync(join(tmpdir(), "advisor-store-ci-"));
	try {
		mkdirSync(join(cwd, "packages/database"), { recursive: true });
		writeFileSync(
			join(cwd, "packages/database/advisor-result-store-results.json"),
			JSON.stringify(report),
		);
		return spawnSync(process.execPath, [], {
			cwd,
			input: guard,
			encoding: "utf8",
		});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}
describe("Advisor result-store CI execution guard", () => {
	it("runs the integration file with explicit opt-in and disallows no-tests", () => {
		const step = source
			.split("Run Advisor result storage against real Postgres")[1]
			?.split("- name:")[0];
		expect(step).toContain("RUN_DB_INTEGRATION: '1'");
		expect(step).toContain(
			"__tests__/advisor-tool-results.integration.test.ts",
		);
		expect(step).toContain("--passWithNoTests=false");
		expect(step).toContain(
			"--reporter=json --outputFile=advisor-result-store-results.json",
		);
		expect(guard).toBeTruthy();
		expect(runGuard(valid).status).toBe(0);
	});
	it.each([
		{ testResults: [] },
		{ numTotalTests: 0 },
		{ numPassedTests: 40 },
		{ numSkippedTests: 1 },
		{ numPendingTests: 1 },
		{ numFailedTests: 1 },
	])(
		"rejects missing, incomplete, skipped or failed execution: %j",
		(change) => {
			const result = runGuard({ ...valid, ...change });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(
				"expected one Advisor result-store file",
			);
		},
	);
});
