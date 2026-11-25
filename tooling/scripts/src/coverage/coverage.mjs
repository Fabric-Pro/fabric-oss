// From the repository root:
// node tooling/scripts/src/coverage/coverage.mjs local [--shards=2] [package or directory ...]
// With no selectors the local command runs every Vitest workspace package.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishReport } from "./aggregate.mjs";
import { coverageJobs, readWorkspace } from "./workspace.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const [command, ...args] = process.argv.slice(2);
const workspace = readWorkspace(root);
const jobs = coverageJobs(workspace.packages);
const environment = {
	...process.env,
	DATABASE_URL: "postgresql://test:test@localhost:5432/test",
	DIRECT_URL: "postgresql://test:test@localhost:5432/test",
	FABRIC_SKIP_BROWSER_E2E: "1",
	TURBO_CACHE_DIR: join(root, ".turbo/cache"),
	CI: "true",
};

function coverageFlags(out) {
	const provider = fileURLToPath(import.meta.resolve("@vitest/coverage-v8"));
	return [
		"--coverage.enabled=true",
		"--coverage.provider=custom",
		`--coverage.customProviderModule=${provider}`,
		"--coverage.reporter=json",
		`--coverage.reportsDirectory=${out}`,
		"--coverage.reportOnFailure=true",
		"--coverage.include=**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
		...[
			"node_modules/**",
			"dist/**",
			".next/**",
			"coverage/**",
			"*.d.ts",
		].map((pattern) => `--coverage.exclude=**/${pattern}`),
		...["lines", "statements", "functions", "branches"].map(
			(metric) => `--coverage.thresholds.${metric}=0`,
		),
		"--testTimeout=60000",
		"--hookTimeout=60000",
		"--retry=2",
		"--reporter=default",
		"--reporter=json",
		`--outputFile.json=${join(out, "results.json")}`,
	];
}

function run(runs, input) {
	for (const { name, dir, index, shards } of runs) {
		const out = join(input, dir, String(index));
		// A fresh directory prevents a failed rerun from reusing old evidence.
		mkdirSync(join(out, ".."), { recursive: true });
		mkdirSync(out);
		const generate = spawnSync(
			"pnpm",
			["turbo", "run", "generate", `--filter=${name}...`],
			{ cwd: root, env: environment, stdio: "inherit" },
		);
		const report = { root };
		if (generate.status !== 0) {
			report.error = `generate failed (${generate.error?.message ?? generate.signal ?? generate.status})`;
		} else {
			const flags = coverageFlags(out);
			if (shards > 1) {
				flags.push(`--shard=${index}/${shards}`);
			}
			const vitest = spawnSync(
				"pnpm",
				["exec", "vitest", "run", ...flags],
				{
					cwd: join(root, dir),
					env: { ...environment, FABRIC_COVERAGE_RUN: "1" },
					stdio: "inherit",
				},
			);
			report.code = vitest.status;
			if (vitest.status === null) {
				report.error = `Vitest crashed (${vitest.error?.message ?? vitest.signal})`;
			}
		}
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, "run.json"), JSON.stringify(report));
	}
}

function aggregate(packages, runs, input, output) {
	const tracked = new Set(
		execFileSync("git", ["ls-files", "-z"], {
			cwd: root,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		}).split("\0"),
	);
	const result = publishReport({
		packages,
		runs,
		noVitest: workspace.noVitest,
		input,
		output,
		tracked,
		stepSummary: process.env.GITHUB_STEP_SUMMARY,
	});
	console.log(result.markdown);
	console.log(`Coverage summary JSON: ${output}`);
	process.exitCode = result.exitCode;
}

switch (command) {
	case "plan":
		console.log(
			JSON.stringify({ include: jobs.map((job) => ({ id: job.id })) }),
		);
		break;
	case "job": {
		const [id, output] = args;
		const job = jobs.find((job) => job.id === id);
		if (!job || !output) {
			throw new Error(
				"Usage: coverage.mjs job <matrix ID> <artifact directory>",
			);
		}
		run(job.runs, resolve(output));
		break;
	}
	case "aggregate": {
		const [input, output] = args;
		aggregate(
			workspace.packages,
			jobs.flatMap((job) => job.runs),
			resolve(input),
			resolve(output),
		);
		break;
	}
	case "local": {
		const shardOverride = args[0] === "--shards=2";
		const selectors = shardOverride ? args.slice(1) : args;
		const selected = new Set();
		for (const selector of selectors) {
			const pkg = workspace.packages.find(
				(pkg) => pkg.name === selector || pkg.dir === selector,
			);
			if (!pkg) {
				throw new Error(
					`No Vitest workspace package matches ${selector}`,
				);
			}
			selected.add(pkg);
		}
		const packages = selectors.length ? [...selected] : workspace.packages;
		const shards = shardOverride ? 2 : 1;
		const runs = selectors.length
			? packages.flatMap((pkg) =>
					Array.from({ length: shards }, (_, index) => ({
						...pkg,
						index: index + 1,
						shards,
					})),
				)
			: jobs.flatMap((job) => job.runs);
		const input = mkdtempSync(join(tmpdir(), "fabric-coverage-"));
		run(runs, input);
		aggregate(packages, runs, input, join(input, "summary.json"));
		break;
	}
	default:
		throw new Error(
			"Usage: coverage.mjs local [--shards=2] [package or directory ...]",
		);
}
