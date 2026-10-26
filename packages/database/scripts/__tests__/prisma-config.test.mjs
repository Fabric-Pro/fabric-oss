import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const cwd = new URL("../../", import.meta.url);

function load(command, variables = {}) {
	const env = { ...process.env, ...variables };
	delete env.DIRECT_URL;
	delete env.SHADOW_DATABASE_URL;
	Object.assign(env, variables);
	return spawnSync(
		process.execPath,
		[
			"--require",
			require.resolve("tsx/cjs"),
			"--eval",
			`process.argv = ['node', 'prisma', ${JSON.stringify(command)}]; console.log(JSON.stringify(require('./prisma.config.ts').default));`,
		],
		{ cwd, env, encoding: "utf8" },
	);
}

test("generation config loads without DIRECT_URL or a database connection", () => {
	const result = load("generate", { DATABASE_URL: "invalid-pooled-url" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).datasource.url, undefined);
});

test("migration config rejects missing DIRECT_URL instead of using DATABASE_URL", () => {
	const result = load("migrate", {
		DATABASE_URL: "postgresql://example:example@localhost:5432/example",
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /DIRECT_URL is required/);
});

test("CLI datasource uses DIRECT_URL and keeps shadow configuration separate", () => {
	const direct = "postgresql://example:example@localhost:5432/example_direct";
	const shadow = "postgresql://example:example@localhost:5432/example_shadow";
	const result = load("migrate", {
		DATABASE_URL: "invalid-pooled-url",
		DIRECT_URL: direct,
		SHADOW_DATABASE_URL: shadow,
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout).datasource, {
		url: direct,
		shadowDatabaseUrl: shadow,
	});
});
