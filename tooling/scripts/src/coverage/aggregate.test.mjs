import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { includesFile, publishReport } from "./aggregate.mjs";
import { coverageJobs, readWorkspace } from "./workspace.mjs";

const tempDirs = [];
const pkg = { name: "example", dir: "packages/example" };
const file = `${pkg.dir}/src/index.ts`;
const tracked = new Set([file]);
function location(line, startColumn, endColumn) {
	return {
		start: { line, column: startColumn },
		end: { line, column: endColumn },
	};
}

const statementMap = {
	0: location(1, 0, 10),
	1: location(2, 0, 10),
	2: location(3, 0, 10),
};

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "statement-coverage-"));
	tempDirs.push(dir);
	return dir;
}

function shard(
	dir,
	index,
	{
		root = "/example/checkout",
		hits = { 0: 0, 1: 7, 2: 0 },
		map = statementMap,
		failure,
		coverage = "valid",
		code = 0,
		results = true,
		error,
		extraFiles = [],
		overrides = {},
	} = {},
) {
	const out = join(dir, pkg.dir, String(index));
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, "run.json"), JSON.stringify({ root, code, error }));
	if (results) {
		writeFileSync(
			join(out, "results.json"),
			JSON.stringify({
				numTotalTests: 2,
				numFailedTests: failure ? 1 : 0,
				numFailedTestSuites: 0,
				success: true,
				testResults: failure
					? [
							{
								status: "failed",
								assertionResults: [
									{ status: "failed", fullName: failure },
								],
							},
						]
					: [],
				...overrides,
			}),
		);
	}
	if (coverage === "missing") {
		return;
	}
	const files = [file, ...extraFiles];
	writeFileSync(
		join(out, "coverage-final.json"),
		coverage === "valid"
			? JSON.stringify(
					Object.fromEntries(
						files.map((path) => [
							join(root, path),
							{ s: hits, statementMap: map },
						]),
					),
				)
			: coverage,
	);
}

test.each([
	["src/index.ts", true],
	["src/config.ts", true],
	["src/generate.ts", true],
	["src/main.test.ts", false],
	["src/main.spec.mts", false],
	["src/main.e2e.tsx", false],
	["src/main.node-test.mjs", false],
	...[
		"__tests__",
		"__mocks__",
		"__fixtures__",
		"fixtures",
		"test",
		"tests",
		"e2e",
	].map((name) => [`src/${name}/data.ts`, false]),
	["vite.config.ts", false],
	["src/build.config.cjs", false],
	["vitest.setup-helper.ts", false],
	["vitest.global-teardown.mts", false],
	["vitest.workspace.ts", false],
	["src/unit.setup.tsx", false],
	["src/type.d.ts", false],
	["src/model.generated.ts", false],
	["generated/data.ts", false],
	["prisma/zod/index.ts", false],
	[".content-collections/generated.ts", false],
])("matches the baseline filter for %s", (path, expected) => {
	const candidate = join(pkg.dir, path);
	assert.equal(
		includesFile(pkg.dir, candidate, new Set([candidate])),
		expected,
	);
});

test("excludes untracked and sibling-package files", () => {
	assert.equal(includesFile(pkg.dir, file, new Set()), false);
	const sibling = "packages/example-other/index.ts";
	assert.equal(includesFile(pkg.dir, sibling, new Set([sibling])), false);
});

test("unions statement hits across runners and publishes totals", () => {
	const dir = fixture();
	const excluded = [
		"src/index.test.ts",
		"vite.config.ts",
		"generated/index.ts",
	].map((path) => join(pkg.dir, path));
	const extraFiles = [
		...excluded,
		join(pkg.dir, "src/untracked.ts"),
		"packages/sibling/index.ts",
	];
	shard(dir, 1, { extraFiles });
	shard(dir, 2, {
		root: "/different/checkout",
		extraFiles,
		hits: { 0: 1, 1: 3, 2: 0 },
	});
	const out = join(dir, "summary.json");
	const stepSummary = join(dir, "step-summary.md");
	const report = publishReport({
		packages: [pkg],
		runs: [
			{ ...pkg, index: 1, shards: 2 },
			{ ...pkg, index: 2, shards: 2 },
		],
		noVitest: [],
		input: dir,
		output: out,
		stepSummary,
		tracked: new Set([
			...tracked,
			...excluded,
			"packages/sibling/index.ts",
		]),
	});
	assert.equal(readFileSync(stepSummary, "utf8"), report.markdown);
	assert.equal(report.exitCode, 0);
	assert.deepEqual(JSON.parse(readFileSync(out)).overall, {
		covered: 2,
		total: 3,
		measured: 1,
		expected: 1,
	});
	assert.match(
		report.markdown,
		/\| example \| 66\.67% \| 2\/3 \| 4 \| measured \|/,
	);
});

function twoShardTotals(dir, trackedFiles = tracked) {
	const output = join(dir, "summary.json");
	const report = publishReport({
		packages: [pkg],
		runs: [
			{ ...pkg, index: 1, shards: 2 },
			{ ...pkg, index: 2, shards: 2 },
		],
		noVitest: [],
		input: dir,
		output,
		tracked: trackedFiles,
	});
	assert.equal(report.exitCode, 0, report.markdown);
	const { covered, total } = JSON.parse(readFileSync(output)).overall;
	return { covered, total };
}

test("merges a shard-only null end column and matches shared ranges by location", () => {
	const dir = fixture();
	const trailing = location(1, 29, null);
	const shared = location(1, 29, 34);
	const hitOnFirst = location(2, 0, 10);
	const uncovered = { ...location(3, 7, 0), end: { line: 4, column: 0 } };
	shard(dir, 1, {
		map: { 0: trailing, 1: shared, 2: hitOnFirst, 3: uncovered },
		hits: { 0: 1, 1: 0, 2: 4, 3: 0 },
	});
	shard(dir, 2, {
		map: { 0: shared, 1: hitOnFirst, 2: uncovered },
		hits: { 0: 2, 1: 0, 2: 0 },
	});
	assert.deepEqual(twoShardTotals(dir), { covered: 3, total: 4 });
});

test("retains files found in only one shard on either side", () => {
	const dir = fixture();
	const left = `${pkg.dir}/src/left.ts`;
	const right = `${pkg.dir}/src/right.ts`;
	shard(dir, 1, { extraFiles: [left] });
	shard(dir, 2, { extraFiles: [right] });
	assert.deepEqual(twoShardTotals(dir, new Set([file, left, right])), {
		covered: 3,
		total: 9,
	});
});

test.each([
	["failed test", { failure: "example suite > broken test" }, /broken test/],
	[
		"failed suite",
		{ overrides: { numFailedTestSuites: 1 } },
		/Vitest failed/,
	],
	["unsuccessful result", { overrides: { success: false } }, /Vitest failed/],
	[
		"bad test count",
		{ overrides: { numTotalTests: -1 } },
		/invalid results.json/,
	],
	[
		"missing coverage",
		{ coverage: "missing" },
		/missing coverage-final.json/,
	],
	[
		"unparseable coverage",
		{ coverage: "{" },
		/unparseable coverage-final.json/,
	],
	["invalid coverage", { coverage: "[]" }, /invalid coverage-final.json/],
	["crash", { code: 137 }, /exit 137/],
	["generation failure", { error: "generate failed (1)" }, /generate failed/],
	[
		"noninteger test count",
		{ overrides: { numTotalTests: 1.5 } },
		/invalid results.json/,
	],
	[
		"missing reporter success",
		{ overrides: { success: undefined } },
		/invalid results.json/,
	],
	["missing statement map", { map: null }, /invalid statements/],
	["missing counts", { hits: null }, /invalid statements/],
	["nonnumeric hit", { hits: { 0: "2", 1: 7, 2: 0 } }, /invalid statements/],
	["missing results", { results: false }, /missing results.json/],
	["fractional hit", { hits: { 0: 0.5, 1: 7, 2: 0 } }, /invalid statements/],
	...[
		["missing start", { end: { line: 1, column: 10 } }],
		[
			"invalid start line",
			{ ...location(1, 0, 10), start: { line: 0, column: 0 } },
		],
		["invalid start column", location(1, null, 10)],
		[
			"invalid end line",
			{ ...location(1, 0, 10), end: { line: 1.5, column: 10 } },
		],
		["invalid end column", location(1, 0, "unknown")],
		[
			"reversed lines",
			{ ...location(2, 0, 10), end: { line: 1, column: 10 } },
		],
		["reversed columns", location(1, 10, 9)],
	].map(([label, malformed]) => [
		label,
		{ map: { ...statementMap, 1: malformed } },
		/invalid statements/,
	]),
	[
		"wrong statement IDs",
		{ hits: { 0: 0, 1: 0, 3: 7 } },
		/invalid statements/,
	],
	[
		"extra statement hit",
		{ hits: { 0: 0, 1: 7, 2: 0, 3: 1 } },
		/invalid statements/,
	],
	[
		"invalid statement hit",
		{ hits: { 0: -1, 1: 7, 2: 0 } },
		/invalid statements/,
	],
	["missing artifact", null, /missing shard artifact/],
])("reports could not measure for %s", (_label, options, reason) => {
	const dir = fixture();
	shard(dir, 1);
	if (options) {
		shard(dir, 2, options);
	}
	const out = join(dir, "summary.json");
	const report = publishReport({
		packages: [pkg],
		runs: [
			{ ...pkg, index: 1, shards: 2 },
			{ ...pkg, index: 2, shards: 2 },
		],
		noVitest: [],
		input: dir,
		output: out,
		tracked,
	});
	assert.equal(report.exitCode, 1);
	assert.match(report.markdown, /could not measure/);
	assert.match(report.markdown, reason);
	assert.match(
		report.markdown,
		/incomplete: 1 of 1 packages could not be measured/,
	);
	assert.equal(JSON.parse(readFileSync(out)).overall.total, 0);
});

test("derives suites and the not-measured list from workspace scripts", () => {
	const root = fixture();
	const entries = [
		["with-suite", "vitest --run"],
		["node-suite", "node --test"],
		["without-suite"],
		["other-suite", "echo vitest"],
		["pnpm-suite", "pnpm exec vitest run"],
	];
	const workspace = entries.map(([name, script]) => {
		const path = join(root, name);
		mkdirSync(path);
		writeFileSync(
			join(path, "package.json"),
			JSON.stringify({ scripts: { test: script } }),
		);
		return { name, path };
	});
	const { packages, noVitest } = readWorkspace(root, workspace);
	assert.deepEqual(
		packages.map((entry) => entry.name),
		["pnpm-suite", "with-suite"],
	);
	assert.deepEqual(
		noVitest.map((entry) => entry.name),
		["node-suite", "other-suite", "without-suite"],
	);
	assert.equal(coverageJobs(packages).flatMap((job) => job.runs).length, 2);
	const report = publishReport({
		packages: [],
		runs: [],
		noVitest,
		input: root,
		output: join(root, "summary.json"),
		tracked,
	});
	assert.match(
		report.markdown,
		/not measured: no Vitest suite[\s\S]+node-suite[\s\S]+without-suite/,
	);
});

test("plans each of 20 Vitest packages with the expected shard jobs", () => {
	const special = [
		{ name: "@repo/web", dir: "apps/web" },
		{ name: "@repo/temporal", dir: "packages/temporal" },
		{ name: "@repo/api", dir: "packages/api" },
	];
	const rest = Array.from({ length: 17 }, (_, index) => ({
		name: `example-${index}`,
		dir: `packages/example-${index}`,
	}));
	const packages = [...special, ...rest];
	const jobs = coverageJobs(packages);
	assert.deepEqual(jobs, [
		...special.flatMap((pkg, offset) => {
			const shards = 3 - offset;
			return Array.from({ length: shards }, (_, index) => ({
				id: `${pkg.name.split("/")[1]}-${index + 1}`,
				runs: [{ ...pkg, index: index + 1, shards }],
			}));
		}),
		{
			id: "rest-1",
			runs: rest
				.slice(0, 9)
				.map((pkg) => ({ ...pkg, index: 1, shards: 1 })),
		},
		{
			id: "rest-2",
			runs: rest.slice(9).map((pkg) => ({ ...pkg, index: 1, shards: 1 })),
		},
	]);
});

test("reports a workspace package omitted from the plan as not planned", () => {
	const input = fixture();
	shard(input, 1);
	const omitted = { name: "omitted", dir: "packages/omitted" };
	const output = join(input, "summary.json");
	const report = publishReport({
		packages: [pkg, omitted],
		runs: [{ ...pkg, index: 1, shards: 1 }],
		noVitest: [],
		input,
		output,
		tracked,
	});
	assert.equal(report.exitCode, 1);
	assert.match(
		report.markdown,
		/incomplete: 1 of 2 packages could not be measured/,
	);
	assert.match(
		report.markdown,
		/\| omitted \| — \| — \| — \| could not measure: not planned \|/,
	);
	assert.deepEqual(JSON.parse(readFileSync(output)).overall, {
		covered: 1,
		total: 3,
		measured: 1,
		expected: 2,
	});
});

test.each([
	["missing shard", [1], [2], pkg.dir],
	["duplicate shard", [1, 1], [2, 2], pkg.dir],
	["out-of-range shard", [1, 3], [2, 2], pkg.dir],
	["inconsistent shard count", [1, 2], [2, 3], pkg.dir],
	["incorrect package directory", [1], [1], "packages/other"],
])("rejects a plan with %s", (_label, indices, counts, dir) => {
	const input = fixture();
	shard(input, 1);
	shard(input, 2);
	const report = publishReport({
		packages: [pkg],
		runs: indices.map((index, offset) => ({
			...pkg,
			dir,
			index,
			shards: counts[offset],
		})),
		noVitest: [],
		input,
		output: join(input, "summary.json"),
		tracked,
	});
	assert.equal(report.exitCode, 1);
	assert.match(report.markdown, /could not measure: invalid shard plan/);
});

test.each([false, true])(
	"rejects a package outside the Vitest workspace (also omitted: %s)",
	(alsoOmitted) => {
		const input = fixture();
		shard(input, 1);
		const omitted = { name: "omitted", dir: "packages/omitted" };
		const report = publishReport({
			packages: alsoOmitted ? [pkg, omitted] : [pkg],
			runs: [
				{ ...pkg, index: 1, shards: 1 },
				{
					name: "unexpected",
					dir: "packages/unexpected",
					index: 1,
					shards: 1,
				},
			],
			noVitest: [],
			input,
			output: join(input, "summary.json"),
			tracked,
		});
		assert.equal(report.exitCode, 1);
		assert.match(
			report.markdown,
			/Unexpected packages in coverage plan: unexpected/,
		);
		if (alsoOmitted) {
			assert.match(
				report.markdown,
				/incomplete: 1 of 2 packages could not be measured/,
			);
			assert.match(report.markdown, /could not measure: not planned/);
		}
	},
);
