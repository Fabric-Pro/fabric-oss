/**
 * CI fixture test for the noRestrictedImports lint guard: a Biome
 * `noRestrictedImports` rule must
 * block direct imports of `@ai-sdk/*` provider packages and the raw
 * `ai` SDK constructors (`generateText`, `streamText`, `embed`, etc.)
 * from any path outside the chokepoint at `packages/ai/**`. This test
 * statically asserts that the rule fires on a stub source so that any
 * future change to `biome.json` (or to a per-package override that
 * accidentally turns the rule off) is caught in CI.
 * Strategy
 * The fixture lives at `fixtures/ai-sdk-import-violation.ts.txt` with
 * a `.ts.txt` extension so Biome itself never lints it directly during
 * a normal `pnpm lint.` scan (the workspace lints `.ts`/`.tsx` only).
 * The test:
 * 1. Copies the fixture into a unique temp `.ts` file inside
 * `os.tmpdir` (OUTSIDE the workspace, so a `pnpm lint.` scan
 * never sees it even if cleanup fails).
 * 2. Invokes `biome lint --reporter=json --config-path=<repo-root> <tempfile>`.
 * The `--config-path` flag tells Biome to apply the workspace's
 * production `biome.json` even though the file lives outside the
 * workspace tree.
 * 3. Parses the JSON output and asserts that two
 * `lint/style/noRestrictedImports` diagnostics fire — one for
 * the `@ai-sdk/openai` package import (matched by
 * `patterns.group`) and one for the `generateText` named import
 * from `ai` (matched by `paths.ai.importNames`).
 * Cleanup uses `try/finally`. Because the temp file lives in the OS
 * tmp dir (which is outside the workspace), residue from a crashed
 * test run never affects subsequent `pnpm lint.` runs.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../../..");
const FIXTURE_PATH = resolve(
	__dirname,
	"fixtures",
	"ai-sdk-import-violation.ts.txt",
);
// Resolve the underlying Node.js entry that `node_modules/.bin/biome`
// dispatches to so we can invoke it directly via `process.execPath`
// without `shell: true`. Bypassing the shell wrapper keeps Semgrep's
// `spawn-shell-true` rule happy (security audit) and works the same on
// POSIX and Windows since we always run it through `node`.
const BIOME_JS = resolve(
	REPO_ROOT,
	"node_modules",
	"@biomejs",
	"biome",
	"bin",
	"biome",
);

type BiomeDiagnostic = {
	category: string;
	severity: string;
	description: string;
};

type BiomeJsonReport = {
	summary: {
		errors: number;
		warnings: number;
	};
	diagnostics: BiomeDiagnostic[];
};

/**
 * Writes the fixture into a unique temp `.ts` file in `os.tmpdir`,
 * runs `biome lint --reporter=json --config-path=<REPO_ROOT> <file>`,
 * and returns the parsed JSON report. Always cleans up the temp dir.
 */
function lintFixture(): BiomeJsonReport {
	const tempDir = mkdtempSync(join(tmpdir(), "ai-sdk-guard-"));
	const tempFile = join(tempDir, "violation.ts");
	const fixtureSource = readFileSync(FIXTURE_PATH, "utf8");
	writeFileSync(tempFile, fixtureSource, "utf8");

	try {
		// `biome lint --reporter=json <file>` exits 1 when violations
		// are found. `spawnSync` returns the result either way (no
		// throw on non-zero exit). We invoke Biome's Node entry via
		// `process.execPath` so `shell: false` (the secure default)
		// works on both POSIX and Windows.
		const result = spawnSync(
			process.execPath,
			[
				BIOME_JS,
				"lint",
				"--reporter=json",
				`--config-path=${REPO_ROOT}`,
				tempFile,
			],
			{
				cwd: REPO_ROOT,
				encoding: "utf8",
			},
		);
		return parseBiomeJson(result.stdout ?? "");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

/**
 * Biome's --reporter=json prints an unstable-API banner line on the
 * first line of stdout, then the JSON document. Find the JSON span
 * by scanning for the outermost braces and parse only that.
 */
function parseBiomeJson(stdout: string): BiomeJsonReport {
	const trimmed = stdout.trim();
	const jsonStart = trimmed.indexOf("{");
	if (jsonStart < 0) {
		throw new Error(`No JSON in biome output: ${trimmed.slice(0, 200)}`);
	}
	const jsonEnd = trimmed.lastIndexOf("}");
	const jsonString = trimmed.slice(jsonStart, jsonEnd + 1);
	return JSON.parse(jsonString) as BiomeJsonReport;
}

describe("ai-sdk-import-guard (Biome noRestrictedImports)", () => {
	it("fires lint/style/noRestrictedImports on a stub source that imports @ai-sdk/openai and generateText from ai", () => {
		const report = lintFixture();

		const violations = report.diagnostics.filter(
			(d) => d.category === "lint/style/noRestrictedImports",
		);

		// Two violations expected: one for the @ai-sdk/openai package
		// import (matched by `patterns.group`) and one for the
		// `generateText` named import from `ai` (matched by
		// `paths.ai.importNames`).
		expect(violations.length).toBeGreaterThanOrEqual(2);

		// At least one violation must reference an @ai-sdk/* package
		// (the patterns/group deny rule).
		const aiSdkPackageViolation = violations.find((d) =>
			d.description.includes("@ai-sdk/*"),
		);
		expect(aiSdkPackageViolation).toBeDefined();

		// At least one violation must reference the model-construction
		// or model-invocation specifiers from `ai` (the
		// paths.ai.importNames deny rule).
		const aiNamedImportViolation = violations.find((d) =>
			d.description.includes("model-construction or model-invocation"),
		);
		expect(aiNamedImportViolation).toBeDefined();

		// Both violations must point users at the chokepoint helpers so
		// the failure message is actionable.
		for (const v of [aiSdkPackageViolation, aiNamedImportViolation]) {
			expect(v?.description).toContain("getAIModelWithMetadata");
			expect(v?.description).toContain("@repo/ai");
			expect(v?.description).toContain(
				"fabric/standards/ai/llm-integration.md",
			);
		}

		// The summary must report errors (severity is "error" in the
		// rule config) — proves the rule level is "error", not "warn".
		expect(report.summary.errors).toBeGreaterThanOrEqual(2);
	});
});
