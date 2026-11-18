import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	cutoffTables,
	ensureCommit,
	main,
	runCases,
	validateDataset,
} from "../eval/run.mjs";
import { QUESTIONS as partialResults } from "../eval/variants/failure-success-partial-results.mjs";
import { QUESTIONS as linkedRecords } from "../eval/variants/tenant-scope-linked-records.mjs";
import { run } from "../main.mjs";
import { QUESTION_DETAILS, QUESTIONS } from "../questions.mjs";
import { evaluate, parseCutoff } from "../review.mjs";

const sample = {
	id: "example-case",
	base: "a".repeat(40),
	head: "b".repeat(40),
	question: "all",
	label: "clean",
	note: "Scoped query preserves its existing filters.",
	source: "clean-sample",
};
const answer = (probability) => ({
	answers: Object.fromEntries(
		Object.keys(QUESTIONS).map((key) => [key, { probability }]),
	),
});
const files = [{ path: "example.ts", diff: "@@ -0,0 +1 @@\n+example();\n" }];

test("cutoff table uses inclusive boundaries and question-specific labels", () => {
	const results = [
		{
			...sample,
			question: "authz",
			label: "defect",
			status: "evaluated",
			scores: { authz: 0.85 },
		},
		{
			...sample,
			question: "authz",
			label: "clean",
			status: "evaluated",
			scores: { authz: 0.8 },
		},
		{ ...sample, status: "evaluated", scores: { authz: 0.7 } },
		{
			...sample,
			question: "secrets",
			status: "evaluated",
			scores: { authz: 0.99 },
		},
	];
	assert.deepEqual(
		cutoffTables(results, ["authz"]).authz.map(
			({
				cutoff,
				defectsCaught,
				defectsTotal,
				cleanFlagged,
				cleanTotal,
			}) => [
				cutoff,
				defectsCaught,
				defectsTotal,
				cleanFlagged,
				cleanTotal,
			],
		),
		[
			[0.7, 1, 1, 2, 2],
			[0.75, 1, 1, 1, 2],
			[0.8, 1, 1, 1, 2],
			[0.85, 1, 1, 0, 2],
			[0.9, 0, 1, 0, 2],
			[0.95, 0, 1, 0, 2],
		],
	);
});

test("incomplete cases retain partial scores and stay out of denominators", async () => {
	const large = {
		path: "large.ts",
		diff: `@@ -0,0 +1 @@\n+${"x".repeat(70_000)}\n`,
	};
	const manyFiles = Array.from({ length: 21 }, (_, i) => ({
		path: `example-${i}.ts`,
		diff: `@@ -0,0 +1 @@\n+${"x".repeat(31_000)}\n`,
	}));
	for (const [reason, readFiles, decide] of [
		[
			"model request error or timeout",
			() => [...files, { ...large, diff: large.diff.slice(0, 59_990) }],
			({ state }) => {
				if (state.diff.includes("example()")) {
					return answer(0.95);
				}
				throw new Error("private error text");
			},
		],
		["invalid model answer", () => files, () => ({ answers: {} })],
		["source diff truncated", () => [large], () => answer(0.1)],
		["source requests skipped", () => manyFiles, () => answer(0.1)],
		["no source diff", () => [], () => answer(0.1)],
		[
			"git diff failed",
			() => {
				throw new Error("private git error");
			},
			() => assert.fail("must read the diff first"),
		],
		[
			"diff packing or evaluation setup failed",
			() => [{ ...large, diff: "x".repeat(70_000) }],
			() => answer(0.1),
		],
	]) {
		const results = await runCases(
			[
				sample,
				{
					...sample,
					id: "defect-example",
					question: "authz",
					label: "defect",
				},
			],
			{ readFiles, ensure: async () => {}, decide, questionDetails: {} },
		);
		for (const result of results) {
			assert.equal(result.status, "not evaluated", reason);
			assert.ok(result.reasons.includes(reason), reason);
		}
		if (reason === "model request error or timeout") {
			assert.equal(results[0].scores.authz, 0.95);
		}
		assert.doesNotMatch(JSON.stringify(results), /private/);
		const [row] = cutoffTables(results, ["authz"]).authz;
		assert.equal(row.cleanTotal, 0);
		assert.equal(row.defectsTotal, 0);
	}
});

test("missing commits are fetched and must resolve before the diff is read", async () => {
	const calls = [];
	let fetched = false;
	const git = async (args) => {
		calls.push(args);
		if (args[0] === "fetch") {
			fetched = true;
		} else if (!fetched) {
			throw new Error("unknown");
		}
	};
	await ensureCommit(sample.head, git);
	assert.deepEqual(calls, [
		["cat-file", "-e", `${sample.head}^{commit}`],
		["fetch", "origin", sample.head],
		["cat-file", "-e", `${sample.head}^{commit}`],
	]);
	calls.length = 0;
	await ensureCommit(sample.head, git);
	assert.equal(calls.length, 1);
	const results = await runCases([sample], {
		ensure: (sha) =>
			ensureCommit(sha, async () => {
				throw new Error("private");
			}),
		readFiles: () => assert.fail("must resolve commits first"),
		decide: () => assert.fail("must resolve commits first"),
	});
	assert.equal(results[0].status, "not evaluated");
	assert.deepEqual(results[0].reasons, ["commit unavailable"]);
});

test("CLI passes alternate instructions, scopes the report and writes raw scores", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "jev-review-"));
	t.after(() => rm(dir, { force: true, recursive: true }));
	const variant = join(dir, "variant.mjs");
	const datasetPath = join(dir, "dataset.json");
	const output = join(dir, "results.json");
	const questions = {
		...QUESTIONS,
		tenant_scope: "Synthetic alternate wording.",
	};
	await writeFile(
		variant,
		`export const QUESTIONS = ${JSON.stringify(questions)};\n`,
	);
	await writeFile(
		datasetPath,
		JSON.stringify([
			sample,
			{ ...sample, id: "other-question", question: "authz" },
			{
				...sample,
				id: "unavailable",
				question: "tenant_scope",
				head: "c".repeat(40),
			},
		]),
	);
	const seen = [];
	const messages = [];
	await main(
		["--questions", variant, "--only", "tenant_scope", "--out", output],
		{
			apiKey: "synthetic-key",
			questionDetails: {},
			datasetPath,
			ensure: async (sha) => {
				if (sha === "c".repeat(40)) {
					throw new Error("synthetic-key");
				}
			},
			readFiles: async () => files,
			load: (apiKey) => ({
				decide: ({ questions: sent }) => {
					assert.equal(apiKey, "synthetic-key");
					seen.push(sent);
					return answer(0.812345);
				},
			}),
			report: (message) => messages.push(message),
		},
	);
	assert.deepEqual(
		seen[0],
		Object.fromEntries(
			Object.entries(questions).map(([key, instructions]) => [
				key,
				{ type: "boolean", instructions },
			]),
		),
	);
	assert.equal(seen.length, 1);
	const raw = await readFile(output, "utf8");
	const result = JSON.parse(raw);
	assert.deepEqual(Object.keys(result.tables), ["tenant_scope"]);
	assert.deepEqual(
		result.cases.map((entry) => entry.id),
		["example-case", "unavailable"],
	);
	assert.equal(result.cases[0].scores.tenant_scope, 0.812345);
	assert.ok(messages.join("\n").includes("unavailable: not evaluated"));
	assert.doesNotMatch(raw + messages.join("\n"), /synthetic-key/);
});

test("CLI without the gateway key exits nonzero before evaluation", () => {
	assert.throws(
		() =>
			execFileSync(
				process.execPath,
				["tooling/jev-pr-review/eval/run.mjs"],
				{
					env: {},
					stdio: "pipe",
				},
			),
		(error) =>
			error.status === 1 &&
			/Missing AI_GATEWAY_API_KEY/.test(error.stderr),
	);
});

test("CLI rejects an unknown question and incomplete alternate maps before model setup", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "jev-review-"));
	t.after(() => rm(dir, { force: true, recursive: true }));
	const datasetPath = join(dir, "dataset.json");
	await writeFile(datasetPath, JSON.stringify([sample]));
	const options = {
		apiKey: "synthetic-key",
		datasetPath,
		load: () => assert.fail("must validate options first"),
	};
	await assert.rejects(main(["--only", "unknown"], options), /--only must/);
	for (const [index, content] of [
		"export const OTHER = {};",
		`export const QUESTIONS = ${JSON.stringify({ ...QUESTIONS, extra: "extra" })};`,
		`export const QUESTIONS = Object.assign(Object.create({ authz: "inherited" }), ${JSON.stringify({ ...QUESTIONS, authz: undefined, extra: "extra" })});`,
		`export const QUESTIONS = { ...${JSON.stringify(QUESTIONS)}, authz: { trim: () => "not a string" } };`,
		`export const QUESTIONS = ${JSON.stringify({ ...QUESTIONS, authz: "  " })};`,
	].entries()) {
		const path = join(dir, `variant-${index}.mjs`);
		await writeFile(path, content);
		await assert.rejects(
			main(["--questions", path], options),
			/--questions must load/,
		);
	}
});

test("dataset schema rejects malformed inputs", () => {
	for (const [field, value] of [
		["id", ""],
		["id", 1],
		["base", "b".repeat(39)],
		["head", "z".repeat(40)],
		["head", 1],
		["head", ["b".repeat(40)]],
		["question", "wrong"],
		["label", "unknown"],
		["note", ""],
		["note", 1],
		["note", "two\nlines"],
		["source", "unknown"],
	]) {
		assert.throws(() => validateDataset([{ ...sample, [field]: value }]), {
			message: `Invalid dataset case 1 (${field})`,
		});
	}
	assert.throws(() => validateDataset({}), /array/);
	assert.throws(() => validateDataset([null]), /expected object/);
	assert.throws(() => validateDataset(["case"]), /expected object/);
	assert.throws(() => validateDataset([sample, sample]), /duplicate id/);
	assert.throws(
		() => validateDataset([{ ...sample, label: "defect" }]),
		/question/,
	);
	assert.deepEqual(validateDataset([sample]), [sample]);
});

test("the shipped dataset satisfies the case schema", async () => {
	const dataset = JSON.parse(
		await readFile(
			new URL("../eval/dataset.json", import.meta.url),
			"utf8",
		),
	);
	assert.ok(validateDataset(dataset).length > 0);
});

test("each shipped variant changes only its intended question", () => {
	for (const [key, variant] of [
		["failure_success", partialResults],
		["tenant_scope", linkedRecords],
	]) {
		assert.deepEqual(Object.keys(variant), Object.keys(QUESTIONS));
		assert.notEqual(variant[key], QUESTIONS[key]);
		assert.deepEqual({ ...variant, [key]: QUESTIONS[key] }, QUESTIONS);
	}
});

test("live review honors shipped cutoff boundaries and eval keeps the raw scores", async () => {
	const keys = Object.keys(QUESTIONS);
	for (const atBoundary of [true, false]) {
		const scores = Object.fromEntries(
			keys.map((key) => {
				const cutoff =
					QUESTION_DETAILS[key].cutoff ?? parseCutoff(undefined);
				const below =
					cutoff -
					Math.max(cutoff * Number.EPSILON, Number.MIN_VALUE);
				return [key, atBoundary ? cutoff : below];
			}),
		);
		const localizations = [];
		const decide = async ({ questions }) => {
			const asked = Object.keys(questions);
			if (asked.length === 1) {
				localizations.push(asked[0]);
			}
			return {
				answers: Object.fromEntries(
					asked.map((key) => [key, { probability: scores[key] }]),
				),
			};
		};
		const expected = atBoundary ? keys : [];
		const { rows } = await evaluate({ files, decide });
		assert.deepEqual(
			rows.filter((row) => row.failed).map((row) => row.key),
			expected,
		);
		assert.deepEqual(localizations.splice(0), expected);

		const posts = [];
		assert.equal(
			await run({
				env: { AI_GATEWAY_API_KEY: "synthetic", HEAD_SHA: sample.head },
				readFiles: () => files,
				load: () => ({ decide }),
				makeGithub: () => ({
					listComments: async () => [],
					postComment: async ({ body }) => posts.push(body),
				}),
				report: () => {},
			}),
			0,
		);
		assert.equal(posts.length, expected.length);
		assert.deepEqual(localizations.splice(0), expected);

		const [result] = await runCases([sample], {
			ensure: async () => {},
			readFiles: () => files,
			decide,
		});
		assert.equal(result.status, "evaluated");
		assert.deepEqual(result.scores, scores);
		assert.deepEqual(localizations, []);
	}
});

test("calibration keeps above-cutoff scores when live localization would fail", async () => {
	const calls = [];
	const decide = async ({ questions }) => {
		const asked = Object.keys(questions);
		calls.push(asked);
		if (asked.length === 1) {
			throw new Error("synthetic localization failure");
		}
		const result = answer(0.1);
		result.answers.authz.probability = 0.9;
		return result;
	};
	const keys = Object.keys(QUESTIONS);
	for (const cutoff of [0.85, 0.95]) {
		const results = await runCases([sample], {
			ensure: async () => {},
			readFiles: () => files,
			questionDetails: { authz: { cutoff } },
			decide,
		});
		assert.equal(results[0].status, "evaluated");
		assert.equal(results[0].scores.authz, 0.9);
		assert.deepEqual(calls.splice(0), [keys]);
		const row = cutoffTables(results, ["authz"]).authz.find(
			(row) => row.cutoff === 0.9,
		);
		assert.equal(row.cleanTotal, 1);
		assert.equal(row.cleanFlagged, 1);
	}

	const posts = [];
	const code = await run({
		env: { AI_GATEWAY_API_KEY: "synthetic", HEAD_SHA: sample.head },
		readFiles: () => files,
		load: () => ({ decide }),
		questionDetails: { authz: { cutoff: 0.85 } },
		makeGithub: () => ({
			listComments: async () => [],
			postComment: async (post) => posts.push(post),
		}),
		report: () => {},
	});
	assert.equal(code, 0);
	assert.deepEqual(calls, [keys, ["authz"]]);
	assert.equal(posts.length, 1);
	assert.equal(posts[0].path, files[0].path);
	assert.match(posts[0].body, /could not be pinned down/);
});
