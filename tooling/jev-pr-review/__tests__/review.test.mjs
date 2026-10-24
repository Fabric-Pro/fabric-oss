import assert from "node:assert/strict";
import test from "node:test";
import { QUESTIONS } from "../questions.mjs";
import {
	commentBody,
	evaluate,
	isSourceFile,
	marker,
	packDiffs,
	parseCutoff,
	summaryTable,
} from "../review.mjs";

const file = (path = "src/a.ts", size = 10) => ({
	path,
	diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${"x".repeat(size)}\n`,
});
const answer = (score) => ({
	answers: Object.fromEntries(
		Object.keys(QUESTIONS).map((key) => [key, { probability: score }]),
	),
});

test("cutoff boundary: exactly 0.8 fails and 0.79 passes", async () => {
	for (const [score, failed] of [
		[0.8, true],
		[0.79, false],
	]) {
		const result = await evaluate({
			files: [file()],
			decide: async () => answer(score),
		});
		assert.equal(result.rows[0].failed, failed);
	}
});

test("invalid cutoff defaults to 0.8", () => {
	for (const input of [
		undefined,
		"",
		" ",
		"bad",
		"0.7junk",
		"-1",
		"1.1",
		"Infinity",
	]) {
		assert.equal(parseCutoff(input), 0.8);
	}
	assert.equal(parseCutoff("0"), 0);
	assert.equal(parseCutoff("1"), 1);
});

test("source filter excludes tests, fixtures, generated and declarations", () => {
	for (const path of ["a.ts", "a.tsx", "a.js", "a.mjs", "a.cjs", "a.py"]) {
		assert.ok(isSourceFile(path));
	}
	for (const path of [
		"a.md",
		"a.d.ts",
		"__tests__/a.ts",
		"src/a.test.ts",
		"src/a.spec.ts",
		"tests/a.py",
		"test/a.js",
		"src/tests/a.ts",
		"fixtures/a.ts",
		"generated/a.ts",
	]) {
		assert.ok(!isSourceFile(path), path);
	}
});

test("packing keeps small PR together and large PR whole files in order", () => {
	const files = [file("a.ts", 100), file("b.ts", 100)];
	assert.equal(packDiffs(files).length, 1);
	const packed = packDiffs(files, 200);
	assert.equal(packed.length, 2);
	assert.deepEqual(
		packed.map((r) => r.parts[0].path),
		["a.ts", "b.ts"],
	);
	assert.ok(packed.every((r) => r.diff.length <= 200));
});

test("oversize file splits by hunk with repeated header", () => {
	const source = file("a.ts", 80);
	source.diff += `@@ -9 +9 @@\n+${"y".repeat(80)}\n`;
	const packed = packDiffs([source], 180);
	assert.equal(packed.length, 2);
	for (const request of packed) {
		assert.ok(
			request.diff.startsWith(
				"diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ ",
			),
		);
		assert.ok(request.diff.length <= 180);
	}
});

test("giant hunk is truncated within the limit", () => {
	const packed = packDiffs([file("a.ts", 1000)], 200);
	assert.equal(packed.length, 1);
	assert.equal(packed[0].diff.length, 200);
	assert.ok(packed[0].diff.endsWith("[hunk truncated]"));
	assert.equal(packed[0].truncated, true);
	assert.equal(packed[0].parts[0].truncated, true);
});

test("invalid probabilities are unevaluated and identify question/request", async () => {
	for (const score of [
		undefined,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		-0.1,
		1.1,
		"0.9",
	]) {
		const result = await evaluate({
			files: [file()],
			decide: async () => answer(score),
		});
		assert.equal(result.rows[0].failed, false);
		assert.deepEqual(result.rows[0].missing, [1]);
	}
});

test("a valid score does not hide an unanswered request", async () => {
	let calls = 0;
	const result = await evaluate({
		files: [file("a.ts", 30000), file("b.ts", 30000)],
		decide: async () => (++calls === 1 ? answer(0.1) : { answers: {} }),
	});
	assert.deepEqual(result.rows[0].missing, [2]);
});

test("localization chooses max score and lists other flagged files", async () => {
	let calls = 0;
	const result = await evaluate({
		files: [file("a.ts"), file("b.ts")],
		decide: async ({ questions, maxRetries, abortSignal, state }) => {
			assert.equal(maxRetries, 2);
			assert.ok(abortSignal instanceof AbortSignal);
			calls++;
			if (
				Object.keys(questions).length === Object.keys(QUESTIONS).length
			) {
				return answer(0.8);
			}
			return {
				answers: Object.fromEntries(
					Object.keys(questions).map((key) => [
						key,
						{
							probability: state.diff.includes("b/b.ts")
								? 0.95
								: 0.85,
						},
					]),
				),
			};
		},
	});
	assert.equal(calls, 1 + 2 * Object.keys(QUESTIONS).length);
	assert.equal(result.rows[0].path, "b.ts");
	assert.deepEqual(result.rows[0].others, ["a.ts"]);
});

test("localization error uses largest candidate file", async () => {
	const result = await evaluate({
		files: [file("a.ts"), file("b.ts", 100)],
		decide: async ({ questions }) => {
			if (
				Object.keys(questions).length === Object.keys(QUESTIONS).length
			) {
				return answer(0.8);
			}
			throw new Error("unavailable");
		},
	});
	assert.equal(result.rows[0].path, "b.ts");
	assert.equal(result.rows[0].fallback, true);
});

test("comment includes marker, head, confidence, rule and fallback", () => {
	const body = commentBody(
		{ key: "authz", score: 0.9, others: ["a.ts"], fallback: true },
		"a".repeat(40),
	);
	for (const part of [
		marker("authz", "a".repeat(40)),
		"aaaaaaa",
		"0.90",
		"a.ts",
		"could not be pinned down",
		"reply why and resolve",
	]) {
		assert.ok(body.includes(part), part);
	}
});

test("split-file localization takes maximum across parts and visits each file once", async () => {
	const large = file("large.ts", 30000);
	large.diff += `@@ -9 +9 @@\n+${"y".repeat(30000)}\n`;
	const small = file("small.ts");
	const visits = [];
	const result = await evaluate({
		files: [large, small],
		decide: async ({ questions, state }) => {
			if (
				Object.keys(questions).length === Object.keys(QUESTIONS).length
			) {
				const answerSet = answer(0.1);
				answerSet.answers.authz.probability = 0.8;
				return answerSet;
			}
			visits.push(state.diff);
			return {
				answers: {
					authz: {
						probability: state.diff.includes("+yyy")
							? 0.95
							: state.diff.includes("b/small.ts")
								? 0.85
								: 0.1,
					},
				},
			};
		},
	});
	const row = result.rows.find((row) => row.key === "authz");
	assert.equal(row.path, "large.ts");
	assert.deepEqual(row.others, ["small.ts"]);
	assert.equal(visits.length, 3);
	assert.ok(visits.every((diff) => diff.length <= 60000));
});

test("localization considers only files in failing requests", async () => {
	const localized = [];
	const result = await evaluate({
		files: [file("a.ts", 30000), file("b.ts", 30000)],
		decide: async ({ questions, state }) => {
			if (Object.keys(questions).length === 1) {
				localized.push(state.diff);
			}
			return answer(state.diff.includes("b/b.ts") ? 0.1 : 0.9);
		},
	});
	assert.deepEqual(result.errors, []);
	assert.equal(localized.length, Object.keys(QUESTIONS).length);
	assert.ok(localized.every((diff) => !diff.includes("b/b.ts")));
	assert.equal(result.rows[0].path, "a.ts");
	assert.equal(result.rows[0].fallback, false);
});

test("primary model error preserves localization of valid findings and reports affected request", async () => {
	let count = 0;
	const result = await evaluate({
		files: [file("a.ts", 30000), file("b.ts", 30000)],
		decide: async () => {
			if (++count === 2) {
				throw new Error("synthetic timeout");
			}
			return answer(0.9);
		},
	});
	assert.deepEqual(result.errors, [2]);
	assert.deepEqual(result.rows[0].missing, [2]);
	assert.equal(result.rows[0].path, "a.ts");
});

test("generated Prisma Zod output is excluded", () => {
	assert.equal(isSourceFile("packages/database/prisma/zod/index.ts"), false);
});

test("primary requests stop at 20 and report skipped requests", async () => {
	let calls = 0;
	const result = await evaluate({
		files: Array.from({ length: 22 }, (_, i) => file(`f${i}.ts`, 30000)),
		decide: async () => {
			calls++;
			return answer(0.1);
		},
	});
	assert.equal(calls, 20);
	assert.deepEqual(result.skipped, [21, 22]);
	for (const row of result.rows) {
		assert.deepEqual(row.missing, [21, 22]);
		assert.equal(row.failed, false);
	}
});

test("localization has a global 20-call cap and marks fallback in the summary", async () => {
	let localizationCalls = 0;
	const result = await evaluate({
		files: Array.from({ length: 10 }, (_, i) => file(`f${i}.ts`, 10 + i)),
		decide: async ({ questions }) => {
			if (Object.keys(questions).length === 1) {
				localizationCalls++;
			}
			return answer(0.9);
		},
	});
	assert.equal(localizationCalls, 20);
	assert.ok(result.rows.slice(0, 2).every((row) => !row.fallback));
	assert.ok(
		result.rows
			.slice(2)
			.every((row) => row.fallback && row.path === "f9.ts"),
	);
	assert.match(summaryTable(result.rows), /`f9\.ts` \(fallback\)/);
});

test("model calls use a 30-second timeout for both primary and localization", async (t) => {
	const durations = [];
	t.mock.method(AbortSignal, "timeout", (ms) => {
		durations.push(ms);
		return new AbortController().signal;
	});
	await evaluate({ files: [file()], decide: async () => answer(0.9) });
	assert.equal(durations.length, 1 + Object.keys(QUESTIONS).length);
	assert.ok(durations.every((ms) => ms === 30000));
});

test("truncation metadata remains on only the affected hunk parts", async () => {
	const source = file("large.ts", 1000);
	source.diff += "@@ -9 +9 @@\n+small();\n";
	const requests = packDiffs([source], 200);
	assert.equal(requests.length, 2);
	assert.deepEqual(
		requests.map((request) => request.truncated),
		[true, false],
	);
	const result = await evaluate({
		files: [file("large.ts", 70000), file("small.ts")],
		decide: async () => answer(0.1),
	});
	assert.deepEqual(result.truncatedFiles, ["large.ts"]);
});
