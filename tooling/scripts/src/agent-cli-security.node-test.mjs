import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installedConsumers } from "./installed-consumers.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const agents = [
	["api-agent", 8131],
	["task-planner", 8126],
	["story-breakdown", 8127],
	["document-generator", 8124],
	["project-document-generator", 8129],
	["backlog-updater", 8135],
];

function verifyNoCli(source, path) {
	assert.equal(
		source.match(/@langchain\/langgraph-cli|\blanggraph\s+dev\b/)?.[0],
		undefined,
		`${path}: use the existing unified server instead of downloading the CLI`,
	);
}

test("agent source, manifests and scripts cannot invoke or download the retired CLI", () => {
	const files = execFileSync(
		"git",
		[
			"ls-files",
			"--cached",
			"--others",
			"--exclude-standard",
			"--",
			"agents",
			"apps",
			"packages",
			"services",
			"party",
			"party-cf",
			"scripts",
			"tooling",
			"**/package.json",
		],
		{
			cwd: root,
			encoding: "utf8",
			// The file list outgrows the 1 MB default buffer.
			maxBuffer: 64 * 1024 * 1024,
			windowsHide: true,
		},
	)
		.trim()
		.split(/\r?\n/)
		.filter(
			(path) =>
				/\.(?:[cm]?[jt]sx?|json|sh|ya?ml)$/.test(path) &&
				path !==
					"tooling/scripts/src/agent-cli-security.node-test.mjs" &&
				existsSync(join(root, path)),
		);
	assert.ok(files.length > 100);
	for (const path of files) {
		verifyNoCli(readFileSync(join(root, path), "utf8"), path);
	}
	for (const source of [
		'"dev": "langgraph dev --port 8124"',
		'spawn("npx", ["@langchain/langgraph-cli@1.0.3", "dev"])',
		'"@langchain/langgraph-cli": "1.4.5"',
	]) {
		assert.throws(() => verifyNoCli(source, "fixture"));
	}
});

test("the dependency graph cannot restore extract-zip through the retired CLI", () => {
	const yaml = installedConsumers("@changesets/parse", "1.0.0")[0].require(
		"yaml",
	);
	const lockfile = yaml.parse(
		readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
	);
	for (const section of ["packages", "snapshots"]) {
		assert.ok(lockfile[section]);
		for (const name of Object.keys(lockfile[section])) {
			assert.doesNotMatch(
				name,
				/^(?:@langchain\/langgraph-cli|extract-zip)@/,
			);
		}
	}
});

test("six agent development and production entries retain unified protocol and port contracts", () => {
	for (const [agent, port] of agents) {
		const directory = join(root, "agents/langchain", agent);
		const manifest = JSON.parse(
			readFileSync(join(directory, "package.json"), "utf8"),
		);
		assert.equal(
			manifest.scripts.dev,
			`PORT=${port} tsx unified-server.ts`,
		);
		assert.match(manifest.scripts.start, /node dist\/unified-server\.js$/);
		assert.equal(manifest.scripts["dev:all"], undefined);
		assert.equal(manifest.scripts["dev:legacy-agui"], undefined);
		assert.equal(manifest.scripts["dev:legacy-all"], undefined);
		assert.equal(manifest.scripts["dev:proxy"], undefined);
		assert.equal(manifest.scripts["start:proxy"], undefined);
		const build = readFileSync(join(directory, "tsup.config.ts"), "utf8");
		assert.match(build, /entry: \["unified-server.ts"\]/);
		for (const [name, command] of Object.entries(manifest.scripts)) {
			if (name === "start" || name.startsWith("start:")) {
				const entry = /node dist\/([^\s]+)\.js$/.exec(command);
				assert.ok(
					entry,
					`${agent} ${name}: require an emitted server entry`,
				);
				assert.ok(
					build.includes(`"${entry[1]}.ts"`),
					`${agent} ${name}: missing tsup entry`,
				);
			}
		}
		const source = readFileSync(
			join(directory, "unified-server.ts"),
			"utf8",
		);
		assert.match(source, /createUnifiedServer\(/);
		assert.match(
			source,
			/Number.parseInt\(process.env.PORT \|\| "\d+", 10\)/,
		);
		assert.match(source, /AG-UI/);
		assert.match(source, /A2A/);
	}
});
