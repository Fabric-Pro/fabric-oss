import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WRAPPER = fileURLToPath(
	new URL("../run-type-check.mjs", import.meta.url),
);
/** @param {string} path @param {string} contents */
function write(path, contents) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}

/** @param {string} root */
function writeTurbo(root) {
	write(
		join(root, "node_modules/turbo/bin/turbo"),
		[
			'const { writeFileSync } = require("node:fs");',
			"writeFileSync(process.env.TYPE_CHECK_INVOCATION, JSON.stringify({",
			"\targv: process.argv.slice(2),",
			"\tenv: {",
			"\t\tNODE_OPTIONS: process.env.NODE_OPTIONS,",
			"\t\tNEXT_TYPECHECK_SPLIT: process.env.NEXT_TYPECHECK_SPLIT,",
			"\t},",
			"}));",
			'console.log("fake turbo received type-check");',
			"process.exitCode = Number(process.env.TYPE_CHECK_EXIT_CODE ?? 0);",
		].join("\n"),
	);
}

/** @param {string} root */
function writeMatchingLockfiles(root) {
	const lock = "lockfileVersion: '9.0'\nimporters:\n  .: {}\n";
	write(join(root, "pnpm-lock.yaml"), lock);
	write(join(root, "node_modules/.pnpm/lock.yaml"), lock);
}

/**
 * @param {import("node:test").TestContext} t
 * @param {string} name
 * @returns {{ root: string, invocation: string }}
 */
function createFixture(t, name) {
	const root = mkdtempSync(join(tmpdir(), `run-type-check-${name}-`));
	t.after(() => rmSync(root, { force: true, recursive: true }));
	mkdirSync(root, { recursive: true });
	write(join(root, "package.json"), '{"name":"fixture","type":"module"}\n');
	write(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
	writeMatchingLockfiles(root);
	writeTurbo(root);

	if (existsSync(WRAPPER)) {
		const copiedWrapper = join(root, "scripts/run-type-check.mjs");
		write(copiedWrapper, "");
		copyFileSync(WRAPPER, copiedWrapper);
	}

	return { root, invocation: join(root, "turbo-invocation.json") };
}

/**
 * @param {string} root
 * @param {string[]} args
 * @param {Record<string, string | undefined>} [env]
 */
function run(root, args = [], env = {}) {
	const wrapper = existsSync(WRAPPER)
		? join(root, "scripts/run-type-check.mjs")
		: WRAPPER;
	const runner = join(root, "capture-runner.cjs");
	const resultFile = join(root, "wrapper-result.json");
	write(
		runner,
		[
			'const { spawnSync } = require("node:child_process");',
			'const { writeFileSync } = require("node:fs");',
			"const result = spawnSync(process.execPath, process.argv.slice(2), {",
			"\tcwd: process.cwd(),",
			'\tencoding: "utf8",',
			"\tenv: process.env,",
			'\tstdio: ["ignore", "pipe", "pipe"],',
			"});",
			"writeFileSync(process.env.TYPE_CHECK_RESULT, JSON.stringify({",
			"\tcode: result.status ?? 1,",
			'\tstderr: String(result.stderr ?? ""),',
			'\tstdout: String(result.stdout ?? ""),',
			"}));",
		].join("\n"),
	);
	const childEnv = { ...process.env, ...env };
	delete childEnv.NODE_TEST_CONTEXT;
	childEnv.TYPE_CHECK_RESULT = resultFile;
	const runnerResult = spawnSync(
		process.execPath,
		[runner, wrapper, ...args],
		{
			cwd: root,
			encoding: "utf8",
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	assert.equal(runnerResult.status, 0, String(runnerResult.stderr ?? ""));
	return JSON.parse(readFileSync(resultFile, "utf8"));
}

test("fails before Turbo when node_modules and its pnpm snapshot are missing", (t) => {
	const { root, invocation } = createFixture(t, "missing-snapshot");
	rmSync(join(root, "node_modules"), { recursive: true });

	const result = run(root);

	assert.equal(result.code, 1);
	assert.match(result.stderr, /node_modules\/.pnpm\/lock\.yaml is missing/);
	assert.match(result.stderr, /pnpm install --frozen-lockfile/);
	assert.equal(existsSync(invocation), false);
});

test("fails before Turbo when the pnpm snapshot differs from the root lockfile", (t) => {
	const { root, invocation } = createFixture(t, "mismatched-lock");
	write(
		join(root, "pnpm-lock.yaml"),
		"lockfileVersion: '9.0'\nchanged: true\n",
	);

	const result = run(root);

	assert.equal(result.code, 1);
	assert.match(result.stderr, /pnpm-lock.yaml does not match/);
	assert.match(result.stderr, /pnpm install --frozen-lockfile/);
	assert.equal(existsSync(invocation), false);
});

test("fails before Turbo when a workspace dependency link is missing", (t) => {
	const { root, invocation } = createFixture(t, "missing-link");
	write(
		join(root, "packages/consumer/package.json"),
		'{"name":"@repo/consumer","dependencies":{"@repo/target":"workspace:*"}}\n',
	);
	write(
		join(root, "packages/target/package.json"),
		'{"name":"@repo/target"}\n',
	);

	const result = run(root);

	assert.equal(result.code, 1);
	assert.match(
		result.stderr,
		/workspace link .*@repo\/target.*missing or wrong/,
	);
	assert.match(result.stderr, /pnpm install --frozen-lockfile/);
	assert.equal(existsSync(invocation), false);
});

test("fails before Turbo when a workspace dependency link is wrong", (t) => {
	const { root, invocation } = createFixture(t, "wrong-link");
	write(
		join(root, "packages/consumer/package.json"),
		'{"name":"@repo/consumer","dependencies":{"@repo/target":"workspace:*"}}\n',
	);
	write(
		join(root, "packages/target/package.json"),
		'{"name":"@repo/target"}\n',
	);
	write(
		join(root, "packages/wrong/package.json"),
		'{"name":"@repo/wrong"}\n',
	);
	const link = join(root, "packages/consumer/node_modules/@repo/target");
	mkdirSync(dirname(link), { recursive: true });
	symlinkSync(
		join(root, "packages/wrong"),
		link,
		process.platform === "win32" ? "junction" : "dir",
	);

	const result = run(root);

	assert.equal(result.code, 1);
	assert.match(result.stderr, /workspace link .*@repo\/target.*wrong/);
	assert.match(result.stderr, /pnpm install --frozen-lockfile/);
	assert.equal(existsSync(invocation), false);
});

test("ignores package files outside the pnpm workspace patterns", (t) => {
	const { root, invocation } = createFixture(t, "workspace-patterns");
	write(
		join(root, "pnpm-workspace.yaml"),
		'packages:\n  - packages/**\n  - "!packages/generated/**"\n',
	);
	const target = join(root, "packages/target");
	const link = join(root, "packages/consumer/node_modules/@repo/target");
	write(
		join(root, "packages/consumer/package.json"),
		'{"name":"@repo/consumer","dependencies":{"@repo/target":"workspace:*"}}\n',
	);
	write(join(target, "package.json"), '{"name":"@repo/target"}\n');
	write(
		join(root, "packages/generated/stale/package.json"),
		'{"name":"@repo/target","dependencies":{"@repo/missing":"workspace:^"}}\n',
	);
	mkdirSync(dirname(link), { recursive: true });
	symlinkSync(
		target,
		link,
		process.platform === "win32" ? "junction" : "dir",
	);

	const result = run(root, [], { TYPE_CHECK_INVOCATION: invocation });

	assert.equal(result.code, 0, result.stderr);
	assert.equal(existsSync(invocation), true);
});

test("treats every workspace specifier form as a link that must be valid", (t) => {
	for (const [name, specifier] of [
		["caret", "workspace:^1.0.0"],
		["tilde", "workspace:~1.0.0"],
		["relative", "workspace:../target"],
	]) {
		const { root, invocation } = createFixture(t, `workspace-${name}`);
		write(
			join(root, "packages/consumer/package.json"),
			JSON.stringify({
				name: "@repo/consumer",
				dependencies: { "@repo/target": specifier },
			}),
		);
		write(
			join(root, "packages/target/package.json"),
			'{"name":"@repo/target"}\n',
		);

		const result = run(root, [], { TYPE_CHECK_INVOCATION: invocation });

		assert.equal(result.code, 1, specifier);
		assert.match(
			result.stderr,
			/workspace link .*@repo\/target.*missing or wrong/,
			specifier,
		);
		assert.equal(existsSync(invocation), false, specifier);
	}
});

test("accepts a valid scoped workspace alias link", (t) => {
	const { root, invocation } = createFixture(t, "workspace-alias");
	const target = join(root, "packages/target");
	const link = join(root, "packages/consumer/node_modules/compat");
	write(
		join(root, "packages/consumer/package.json"),
		'{"name":"@repo/consumer","dependencies":{"compat":"workspace:@repo/target@*"}}\n',
	);
	write(join(target, "package.json"), '{"name":"@repo/target"}\n');
	mkdirSync(dirname(link), { recursive: true });
	symlinkSync(
		target,
		link,
		process.platform === "win32" ? "junction" : "dir",
	);

	const result = run(root, [], { TYPE_CHECK_INVOCATION: invocation });

	assert.equal(result.code, 0, result.stderr);
	assert.equal(existsSync(invocation), true);
});

test("accepts a valid relative workspace link", (t) => {
	const { root, invocation } = createFixture(t, "workspace-relative-link");
	const target = join(root, "packages/target");
	const link = join(root, "packages/consumer/node_modules/compat");
	write(
		join(root, "packages/consumer/package.json"),
		'{"name":"@repo/consumer","dependencies":{"compat":"workspace:../target"}}\n',
	);
	write(join(target, "package.json"), '{"name":"@repo/target"}\n');
	mkdirSync(dirname(link), { recursive: true });
	symlinkSync(
		target,
		link,
		process.platform === "win32" ? "junction" : "dir",
	);

	const result = run(root, [], { TYPE_CHECK_INVOCATION: invocation });

	assert.equal(result.code, 0, result.stderr);
	assert.equal(existsSync(invocation), true);
});

test("accepts valid name-matched workspace caret and tilde links", (t) => {
	for (const [name, specifier] of [
		["caret", "workspace:^1.0.0"],
		["tilde", "workspace:~1.0.0"],
	]) {
		const { root, invocation } = createFixture(
			t,
			`workspace-valid-${name}`,
		);
		const target = join(root, "packages/target");
		const link = join(root, "packages/consumer/node_modules/@repo/target");
		write(
			join(root, "packages/consumer/package.json"),
			JSON.stringify({
				name: "@repo/consumer",
				dependencies: { "@repo/target": specifier },
			}),
		);
		write(join(target, "package.json"), '{"name":"@repo/target"}\n');
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(
			target,
			link,
			process.platform === "win32" ? "junction" : "dir",
		);

		const result = run(root, [], { TYPE_CHECK_INVOCATION: invocation });

		assert.equal(result.code, 0, `${specifier}: ${result.stderr}`);
		assert.equal(existsSync(invocation), true, specifier);
	}
});

test("accepts valid workspace names that resemble range tokens", (t) => {
	for (const name of ["x", "X", "v1.2.3"]) {
		const { root, invocation } = createFixture(t, `workspace-name-${name}`);
		const target = join(root, "packages/target");
		const link = join(root, "packages/consumer/node_modules", name);
		write(
			join(root, "packages/consumer/package.json"),
			JSON.stringify({
				name: "@repo/consumer",
				dependencies: { [name]: `workspace:${name}` },
			}),
		);
		write(join(target, "package.json"), JSON.stringify({ name }));
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(
			target,
			link,
			process.platform === "win32" ? "junction" : "dir",
		);

		const result = run(root, [], { TYPE_CHECK_INVOCATION: invocation });

		assert.equal(result.code, 0, `${name}: ${result.stderr}`);
		assert.equal(existsSync(invocation), true, name);
	}
});

test("resolves an ordinary range-like workspace token by dependency key", (t) => {
	const { root, invocation } = createFixture(t, "workspace-range-token");
	const target = join(root, "packages/target");
	const link = join(root, "packages/consumer/node_modules/x");
	write(
		join(root, "packages/consumer/package.json"),
		'{"name":"@repo/consumer","dependencies":{"x":"workspace:v1.2.3"}}\n',
	);
	write(join(target, "package.json"), '{"name":"x"}\n');
	mkdirSync(dirname(link), { recursive: true });
	symlinkSync(
		target,
		link,
		process.platform === "win32" ? "junction" : "dir",
	);

	const result = run(root, [], { TYPE_CHECK_INVOCATION: invocation });

	assert.equal(result.code, 0, result.stderr);
	assert.equal(existsSync(invocation), true);
});

test("does not fall back from an explicit missing scoped alias", (t) => {
	const { root, invocation } = createFixture(t, "missing-scoped-alias");
	const fallback = join(root, "packages/fallback");
	const link = join(root, "packages/consumer/node_modules/compat");
	write(
		join(root, "packages/consumer/package.json"),
		'{"name":"@repo/consumer","dependencies":{"compat":"workspace:@repo/missing@*"}}\n',
	);
	write(join(fallback, "package.json"), '{"name":"compat"}\n');
	mkdirSync(dirname(link), { recursive: true });
	symlinkSync(
		fallback,
		link,
		process.platform === "win32" ? "junction" : "dir",
	);

	const result = run(root, [], { TYPE_CHECK_INVOCATION: invocation });

	assert.equal(result.code, 1);
	assert.match(
		result.stderr,
		/workspace dependency compat.*no workspace package/,
	);
	assert.equal(existsSync(invocation), false);
});

test("resolves bare workspace range tokens by dependency key despite collisions", (t) => {
	for (const token of ["x", "v1.2.3"]) {
		const { root, invocation } = createFixture(
			t,
			`workspace-collision-${token}`,
		);
		const target = join(root, "packages/target");
		const collision = join(root, "packages/collision");
		const link = join(root, "packages/consumer/node_modules/@repo/target");
		write(
			join(root, "packages/consumer/package.json"),
			JSON.stringify({
				name: "@repo/consumer",
				dependencies: { "@repo/target": `workspace:${token}` },
			}),
		);
		write(join(target, "package.json"), '{"name":"@repo/target"}\n');
		write(join(collision, "package.json"), JSON.stringify({ name: token }));
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(
			target,
			link,
			process.platform === "win32" ? "junction" : "dir",
		);

		const result = run(root, [], { TYPE_CHECK_INVOCATION: invocation });

		assert.equal(result.code, 0, `${token}: ${result.stderr}`);
		assert.equal(existsSync(invocation), true, token);
	}
});

test("runs a full check with safe defaults and forwarded arguments", (t) => {
	const { root, invocation } = createFixture(t, "full");
	const target = join(root, "packages/target");
	const link = join(root, "packages/consumer/node_modules/@repo/target");
	write(
		join(root, "packages/consumer/package.json"),
		'{"name":"@repo/consumer","dependencies":{"@repo/target":"workspace:*"}}\n',
	);
	write(join(target, "package.json"), '{"name":"@repo/target"}\n');
	mkdirSync(dirname(link), { recursive: true });
	symlinkSync(
		target,
		link,
		process.platform === "win32" ? "junction" : "dir",
	);

	const result = run(root, ["--filter=@repo/api"], {
		NODE_OPTIONS: "--trace-warnings",
		TYPE_CHECK_INVOCATION: invocation,
	});

	assert.equal(result.code, 0, result.stderr);
	const child = JSON.parse(requireRead(invocation));
	assert.deepEqual(child.argv, [
		"type-check",
		"--concurrency=4",
		"--filter=@repo/api",
	]);
	assert.match(child.env.NODE_OPTIONS, /--trace-warnings/);
	assert.match(child.env.NODE_OPTIONS, /--max-old-space-size=12288/);
	assert.equal(child.env.NEXT_TYPECHECK_SPLIT, "true");
});

test("preserves a quoted max-old-space-size option", (t) => {
	const { root, invocation } = createFixture(t, "quoted-heap");

	const result = run(root, [], {
		NODE_OPTIONS: '"--max-old-space-size=2048" --trace-warnings',
		TYPE_CHECK_INVOCATION: invocation,
	});

	assert.equal(result.code, 0, result.stderr);
	const child = JSON.parse(requireRead(invocation));
	assert.equal(
		child.env.NODE_OPTIONS,
		'"--max-old-space-size=2048" --trace-warnings',
	);
});

test("keeps an existing heap limit and scopes changed checks", (t) => {
	const { root, invocation } = createFixture(t, "changed");

	const result = run(root, ["--changed", "--dry=json"], {
		NODE_OPTIONS: "--max_old_space_size=2048 --trace-warnings",
		TURBO_CONCURRENCY: "2",
		TYPE_CHECK_INVOCATION: invocation,
	});

	assert.equal(result.code, 0, result.stderr);
	const child = JSON.parse(requireRead(invocation));
	assert.deepEqual(child.argv, [
		"type-check",
		"--concurrency=2",
		"--filter=...[origin/master]",
		"--dry=json",
	]);
	assert.equal(
		child.env.NODE_OPTIONS,
		"--max_old_space_size=2048 --trace-warnings",
	);
});

test("propagates Turbo's nonzero exit code", (t) => {
	const { root, invocation } = createFixture(t, "turbo-exit");

	const result = run(root, [], {
		TYPE_CHECK_EXIT_CODE: "7",
		TYPE_CHECK_INVOCATION: invocation,
	});

	assert.equal(result.code, 7);
	assert.equal(existsSync(invocation), true);
});

/** @param {string} path */
function requireRead(path) {
	return readFileSync(realpathSync(path), "utf8");
}
