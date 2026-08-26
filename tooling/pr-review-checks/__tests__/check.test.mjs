import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	blankNonCode,
	checkTenantRegistration,
	findUnboundedModelCalls,
	findWorkflowReplayBreaks,
	isReviewableSource,
	isTestPath,
	limitToChanged,
	parseChangedLines,
	renderReport,
	summariseTestCoverage,
} from "../check.mjs";

const DIFF = [
	"diff --git a/packages/api/lib/a.ts b/packages/api/lib/a.ts",
	"--- a/packages/api/lib/a.ts",
	"+++ b/packages/api/lib/a.ts",
	"@@ -10,0 +11,2 @@",
	"+added one",
	"+added two",
	"@@ -40 +42 @@",
	"+changed",
].join("\n");

describe("parseChangedLines", () => {
	it("reads every added line from a multi-hunk diff", () => {
		const changed = parseChangedLines(DIFF);
		const lines = changed.get("packages/api/lib/a.ts");
		assert.deepEqual(
			[...lines].sort((x, y) => x - y),
			[11, 12, 42],
		);
	});

	it("treats a hunk with no count as one line", () => {
		const changed = parseChangedLines("+++ b/x.ts\n@@ -1 +7 @@\n+one");
		assert.deepEqual([...changed.get("x.ts")], [7]);
	});

	it("returns nothing for a diff with no files", () => {
		assert.equal(parseChangedLines("").size, 0);
	});
});

describe("limitToChanged", () => {
	const findings = [
		{ path: "packages/api/lib/a.ts", line: 11, rule: "r" },
		{ path: "packages/api/lib/a.ts", line: 99, rule: "r" },
		{ path: "packages/api/lib/other.ts", line: 11, rule: "r" },
	];

	it("keeps only findings on lines the change introduced", () => {
		const kept = limitToChanged(findings, parseChangedLines(DIFF));
		assert.equal(kept.length, 1);
		assert.equal(kept[0].line, 11);
	});

	it("keeps everything when no diff was supplied", () => {
		// A local run without --diff should still be useful.
		assert.equal(limitToChanged(findings, null).length, 3);
	});
});

const WORKFLOW = "packages/temporal/src/workflows/example-workflow.ts";
const SOURCE = "packages/api/modules/projects/lib/example.ts";

describe("blankNonCode", () => {
	it("blanks a string body but keeps its offsets", () => {
		const out = blankNonCode('const a = "Math.random(";\nconst b = 1;');
		assert.equal(out.includes("Math.random"), false);
		assert.equal(out.split("\n").length, 2);
		assert.equal(
			out.length,
			'const a = "Math.random(";\nconst b = 1;'.length,
		);
	});

	it("blanks line and block comments", () => {
		assert.equal(
			blankNonCode("// Date.now()\nx").includes("Date.now"),
			false,
		);
		assert.equal(
			blankNonCode("/* Date.now()\n more */\nx").includes("Date.now"),
			false,
		);
	});

	it("keeps newlines inside a block comment so line numbers survive", () => {
		const out = blankNonCode("/*\n\n*/\nMath.random()");
		assert.equal(out.split("\n").length, 4);
	});
});

describe("findWorkflowReplayBreaks", () => {
	it("ignores files outside workflow code", () => {
		assert.deepEqual(findWorkflowReplayBreaks(SOURCE, "unsafe.now()"), []);
	});

	it("flags unsafe.now() with its line", () => {
		const found = findWorkflowReplayBreaks(
			WORKFLOW,
			"const a = 1;\nconst t = unsafe.now();",
		);
		assert.equal(found.length, 1);
		assert.equal(found[0].line, 2);
		assert.equal(found[0].rule, "workflow-replay");
	});

	it("flags an audit write from workflow code", () => {
		const found = findWorkflowReplayBreaks(
			WORKFLOW,
			"await recordAudit({ action: 'x' });",
		);
		assert.equal(found.length, 1);
		assert.match(found[0].detail, /activity/);
	});

	it("leaves the SDK's deterministic clock and randomness alone", () => {
		// The Temporal TypeScript SDK makes all three replay-safe, and this
		// repository's own guidance says to use Date.now(). An earlier draft
		// flagged them and produced 28 findings of correct code.
		assert.deepEqual(
			findWorkflowReplayBreaks(
				WORKFLOW,
				"const a = Date.now(); const b = new Date(); const c = Math.random();",
			),
			[],
		);
	});

	it("does not fire on a mention inside a comment", () => {
		assert.deepEqual(
			findWorkflowReplayBreaks(
				WORKFLOW,
				"// never call unsafe.now() here",
			),
			[],
		);
	});
});

describe("checkTenantRegistration", () => {
	it("stays quiet when the schema did not change", () => {
		assert.equal(checkTenantRegistration(["packages/api/lib/a.ts"]), null);
	});

	it("stays quiet when registration changed alongside the schema", () => {
		assert.equal(
			checkTenantRegistration([
				"packages/database/prisma/schema.prisma",
				"packages/database/prisma/tenant-db.ts",
			]),
			null,
		);
	});

	it("asks the question when the schema moved alone", () => {
		const out = checkTenantRegistration([
			"packages/database/prisma/schema.prisma",
		]);
		assert.equal(out.rule, "tenant-registration");
		assert.match(out.detail, /both places/);
	});
});

describe("findUnboundedModelCalls", () => {
	it("flags a call with no output budget", () => {
		const found = findUnboundedModelCalls(
			SOURCE,
			"await generateObject({ model, schema, prompt });",
		);
		assert.equal(found.length, 1);
		assert.equal(found[0].rule, "unbounded-model-call");
	});

	it("accepts a call that states one", () => {
		assert.deepEqual(
			findUnboundedModelCalls(
				SOURCE,
				"await generateObject({ model, schema, maxOutputTokens: 2000 });",
			),
			[],
		);
	});

	it("judges each call separately, not the file", () => {
		// A file where one of two calls forgot it must still be caught.
		const found = findUnboundedModelCalls(
			SOURCE,
			[
				"await generateText({ model, maxOutputTokens: 500 });",
				"await generateObject({ model, schema });",
			].join("\n"),
		);
		assert.equal(found.length, 1);
		assert.equal(found[0].line, 2);
	});

	it("handles a nested object without stopping at the inner paren", () => {
		assert.deepEqual(
			findUnboundedModelCalls(
				SOURCE,
				"await generateObject({ model: pick({ a: 1 }), maxOutputTokens: 10 });",
			),
			[],
		);
	});

	it("ignores test files", () => {
		assert.deepEqual(
			findUnboundedModelCalls(
				"packages/api/__tests__/example.test.ts",
				"generateObject({ model });",
			),
			[],
		);
	});
});

describe("summariseTestCoverage", () => {
	it("says nothing when a test changed too", () => {
		assert.equal(
			summariseTestCoverage([SOURCE, "packages/api/__tests__/a.test.ts"]),
			null,
		);
	});

	it("says nothing when only docs changed", () => {
		assert.equal(summariseTestCoverage(["docs/qa/README.md"]), null);
	});

	it("reports source-without-tests, capped at five examples", () => {
		const many = Array.from(
			{ length: 7 },
			(_, i) => `packages/api/lib/file-${i}.ts`,
		);
		const out = summariseTestCoverage(many);
		assert.equal(out.count, 7);
		assert.equal(out.examples.length, 5);
	});
});

describe("isTestPath / isReviewableSource", () => {
	it("recognises the repository's test layouts", () => {
		assert.equal(isTestPath("packages/api/__tests__/a.test.ts"), true);
		assert.equal(isTestPath("apps/web/x/a.spec.tsx"), true);
		assert.equal(isTestPath("packages/api/lib/a.ts"), false);
	});

	it("ignores anything outside packages and apps", () => {
		assert.equal(isReviewableSource("tooling/x/check.mjs"), false);
		assert.equal(isReviewableSource("packages/api/lib/a.ts"), true);
	});
});

describe("renderReport", () => {
	it("returns null when there is nothing worth saying", () => {
		assert.equal(renderReport([], null), null);
	});

	it("names every finding with its file and line", () => {
		const report = renderReport(
			findWorkflowReplayBreaks(WORKFLOW, "unsafe.now()"),
			null,
		);
		assert.match(report, /example-workflow\.ts:1/);
		assert.match(report, /Workflow replay/);
	});

	it("reports a tenant question on its own", () => {
		const report = renderReport([], null, {
			rule: "tenant-registration",
			detail: "schema moved, registration did not",
		});
		assert.match(report, /Tenant isolation/);
	});
});
