/**
 * Eval Harness for fabric-weave
 *
 * Prompt regression testing to catch prompt changes that break agent contracts
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalCase, EvalResult } from "../src/types/index.js";

const EVALS_DIR = "./evals/cases";

interface EvalSuite {
	name: string;
	cases: EvalCase[];
}

/**
 * Load all eval cases from disk
 */
async function loadEvalCases(): Promise<EvalCase[]> {
	const cases: EvalCase[] = [];

	try {
		const files = await readdir(EVALS_DIR);

		for (const file of files) {
			if (file.endsWith(".json")) {
				const content = await readFile(join(EVALS_DIR, file), "utf-8");
				const suite: EvalSuite = JSON.parse(content);
				cases.push(...suite.cases);
			}
		}
	} catch (_error) {
		console.warn("No eval cases found. Create some in evals/cases/");
	}

	return cases;
}

/**
 * Run a single eval case
 */
async function runEvalCase(testCase: EvalCase): Promise<EvalResult> {
	const start = Date.now();

	try {
		// TODO: Implement agent invocation and validation
		// This is a stub - actual implementation will call agents and validate

		console.log(`Running: ${testCase.name} (${testCase.agent})`);

		return {
			caseId: testCase.id,
			passed: true, // Stub
			actual: {},
			expected: testCase.expected,
			duration: Date.now() - start,
		};
	} catch (error) {
		return {
			caseId: testCase.id,
			passed: false,
			actual: null,
			expected: testCase.expected,
			duration: Date.now() - start,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Run all eval cases
 */
async function runAllEvals(): Promise<void> {
	console.log("🧪 Running fabric-weave eval harness...\n");

	const cases = await loadEvalCases();

	if (cases.length === 0) {
		console.log("No eval cases found. Skipping.");
		return;
	}

	console.log(`Found ${cases.length} eval cases\n`);

	const results: EvalResult[] = [];

	for (const testCase of cases) {
		const result = await runEvalCase(testCase);
		results.push(result);

		const status = result.passed ? "✓" : "✗";
		console.log(`${status} ${testCase.name} (${result.duration}ms)`);

		if (!result.passed && result.error) {
			console.log(`  Error: ${result.error}`);
		}
	}

	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed).length;

	console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

	if (failed > 0) {
		process.exit(1);
	}
}

// Run if called directly
if (import.meta.main) {
	runAllEvals();
}

export { loadEvalCases, runEvalCase, runAllEvals };
