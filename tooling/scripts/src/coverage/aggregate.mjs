import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export function includesFile(packageDir, file, tracked) {
	const path = `/${file}`;
	return (
		tracked.has(file) &&
		(packageDir === "." || file.startsWith(`${packageDir}/`)) &&
		!/\.(test|spec|e2e|node-test)\.[cm]?[jt]sx?$/.test(path) &&
		!/\/(__tests__|__mocks__|__fixtures__|fixtures|tests?|e2e)\//.test(
			path,
		) &&
		!/(^|\/)[^/]*\.config\.[cm]?[jt]s$/.test(path) &&
		!/vitest\.(setup|global-teardown|workspace)/.test(path) &&
		!/\.setup\.[cm]?[jt]sx?$/.test(path) &&
		!/\.d\.ts$/.test(path) &&
		!/(\.generated\.|\/generated\/|\/prisma\/zod\/|\.content-collections\/)/.test(
			path,
		)
	);
}

function readRecord(dir, filename, missing = `missing ${filename}`) {
	let raw;
	try {
		raw = readFileSync(join(dir, filename), "utf8");
	} catch (error) {
		throw new Error(
			error.code === "ENOENT"
				? missing
				: `could not read ${filename} (${error.code})`,
		);
	}
	let record;
	try {
		record = JSON.parse(raw);
	} catch {
		throw new Error(`unparseable ${filename}`);
	}
	if (!isRecord(record)) {
		throw new Error(`invalid ${filename}`);
	}
	return record;
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function testCount(dir, run) {
	if (run.error) {
		throw new Error(run.error);
	}
	if (run.code !== 0) {
		// Keep the process failure even when Vitest crashed before writing JSON.
		try {
			readTestResults(dir);
		} catch (error) {
			throw new Error(`Vitest exit ${run.code}: ${error.message}`);
		}
		throw new Error(`Vitest exit ${run.code}`);
	}
	return readTestResults(dir);
}

function readTestResults(dir) {
	const results = readRecord(dir, "results.json");
	if (
		results.numFailedTests > 0 ||
		results.numFailedTestSuites > 0 ||
		results.success === false
	) {
		const failures = results.testResults
			.filter((suite) => suite.status === "failed")
			.flatMap((suite) => {
				const tests = suite.assertionResults
					.filter((test) => test.status === "failed")
					.map((test) => test.fullName);
				return tests.length ? tests : [suite.name];
			})
			.slice(0, 5);
		throw new Error(
			`Vitest failed${failures.length ? `: ${failures.join(", ")}` : ""}`,
		);
	}
	if (
		!Number.isInteger(results.numTotalTests) ||
		results.numTotalTests < 0 ||
		results.success !== true
	) {
		throw new Error("invalid results.json");
	}
	return results.numTotalTests;
}

function isCoordinate(value, minimum) {
	return Number.isSafeInteger(value) && value >= minimum;
}

function statementKey(location) {
	const start = location?.start;
	const end = location?.end;
	if (
		!isCoordinate(start?.line, 1) ||
		!isCoordinate(start?.column, 0) ||
		!isCoordinate(end?.line, 1) ||
		(end.column !== null && !isCoordinate(end.column, 0)) ||
		end.line < start.line ||
		(end.line === start.line &&
			end.column !== null &&
			end.column < start.column)
	) {
		return null;
	}
	return `${start.line}:${start.column}-${end.line}:${end.column}`;
}

function mergeStatements(merged, file, data) {
	const { statementMap, s } = data ?? {};
	if (
		!isRecord(statementMap) ||
		!isRecord(s) ||
		Object.keys(statementMap).length !== Object.keys(s).length
	) {
		throw new Error(`invalid statements for ${file}`);
	}
	const statements = merged.get(file) ?? new Map();
	for (const [id, location] of Object.entries(statementMap)) {
		const key = statementKey(location);
		const hit = s[id];
		if (key === null || !Number.isSafeInteger(hit) || hit < 0) {
			throw new Error(`invalid statements for ${file}`);
		}
		// Numeric IDs are local to each shard. Credit hits at the exact range.
		statements.set(key, hit > 0 || statements.get(key) === true);
	}
	merged.set(file, statements);
}

function measurePackage(pkg, input, tracked) {
	const merged = new Map();
	let tests = 0;
	for (let index = 1; index <= pkg.shards; index++) {
		try {
			const dir = join(input, pkg.dir, String(index));
			const run = readRecord(
				dir,
				"run.json",
				"missing shard artifact or run status",
			);
			tests += testCount(dir, run);
			const coverage = readRecord(dir, "coverage-final.json");
			for (const [absolute, data] of Object.entries(coverage)) {
				const file = relative(run.root, absolute);
				if (includesFile(pkg.dir, file, tracked)) {
					mergeStatements(merged, file, data);
				}
			}
		} catch (error) {
			return {
				...pkg,
				status: "could not measure",
				reason: `shard ${index}/${pkg.shards}: ${error.message}`,
			};
		}
	}
	let total = 0;
	let covered = 0;
	for (const statements of merged.values()) {
		total += statements.size;
		for (const hit of statements.values()) {
			if (hit) {
				covered++;
			}
		}
	}
	return { ...pkg, status: "measured", tests, covered, total };
}

const percent = (covered, total) =>
	total ? `${((100 * covered) / total).toFixed(2)}%` : "—";
const cell = (value) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("|", "&#124;")
		.replace(/\s+/g, " ");

function measurePlan(packages, runs, input, tracked) {
	const runsByPackage = new Map(packages.map((pkg) => [pkg.name, []]));
	const unexpectedPackages = new Set();
	for (const run of runs) {
		const packageRuns = runsByPackage.get(run.name);
		if (!packageRuns) {
			unexpectedPackages.add(run.name);
			continue;
		}
		packageRuns.push(run);
	}
	const reports = packages.map((pkg) => {
		const planned = runsByPackage.get(pkg.name);
		if (planned.length === 0) {
			return {
				...pkg,
				status: "could not measure",
				reason: "not planned",
			};
		}
		const { shards } = planned[0];
		planned.sort((a, b) => a.index - b.index);
		if (
			planned.length !== shards ||
			planned.some(
				(run, offset) =>
					run.index !== offset + 1 ||
					run.shards !== shards ||
					run.dir !== pkg.dir,
			)
		) {
			return {
				...pkg,
				status: "could not measure",
				reason: "invalid shard plan",
			};
		}
		return measurePackage({ ...pkg, shards }, input, tracked);
	});
	return { reports, unexpectedPackages: [...unexpectedPackages] };
}

export function publishReport({
	packages,
	runs,
	noVitest,
	input,
	output,
	tracked,
	stepSummary,
}) {
	const { reports, unexpectedPackages } = measurePlan(
		packages,
		runs,
		input,
		tracked,
	);
	const measured = reports.filter((pkg) => pkg.status === "measured");
	const expected = reports.length;
	const overall = {
		covered: 0,
		total: 0,
		measured: measured.length,
		expected,
	};
	for (const pkg of measured) {
		overall.covered += pkg.covered;
		overall.total += pkg.total;
	}
	const incomplete = measured.length !== expected;
	const markdown = [
		"## Statement coverage",
		"",
		`**Overall: ${percent(overall.covered, overall.total)} (${overall.covered}/${overall.total})**` +
			(incomplete
				? ` — incomplete: ${expected - measured.length} of ${expected} packages could not be measured`
				: ""),
		...(unexpectedPackages.length
			? [
					"",
					`Unexpected packages in coverage plan: ${unexpectedPackages.map(cell).join(", ")}`,
				]
			: []),
		"",
		"| Package | Statement % | Covered/total | Tests | Status |",
		"| --- | ---: | ---: | ---: | --- |",
		...reports.map((pkg) =>
			pkg.status === "measured"
				? `| ${cell(pkg.name)} | ${percent(pkg.covered, pkg.total)} | ${pkg.covered}/${pkg.total} | ${pkg.tests} | measured |`
				: `| ${cell(pkg.name)} | — | — | — | could not measure: ${cell(pkg.reason)} |`,
		),
		"",
		"### not measured: no Vitest suite",
		"",
		...(noVitest.length
			? noVitest.map((pkg) => `- ${cell(pkg.name)} (${cell(pkg.dir)})`)
			: ["None."]),
		"",
	].join("\n");
	writeFileSync(
		output,
		`${JSON.stringify({ overall, packages: reports, noVitest, unexpectedPackages }, null, 2)}\n`,
	);
	if (stepSummary) {
		appendFileSync(stepSummary, markdown);
	}
	return {
		exitCode: incomplete || unexpectedPackages.length ? 1 : 0,
		markdown,
	};
}
