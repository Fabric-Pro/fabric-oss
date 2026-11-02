import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installedConsumers } from "./installed-consumers.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const utilsConsumers = [
	["@graphql-tools/executor", "2.1.0"],
	["@graphql-tools/merge", "9.2.6"],
	["@graphql-tools/schema", "10.1.3"],
	["@graphql-yoga/plugin-defer-stream", "3.24.4"],
	["graphql-yoga", "5.24.4"],
];
const yaml = installedConsumers("@changesets/parse", "1.0.0")[0].require(
	"yaml",
);
const semver = installedConsumers("@changesets/cli", "3.0.1")[0].require(
	"semver",
);

function verifyUtils(lockfile) {
	for (const section of ["packages", "snapshots"]) {
		assert.ok(
			lockfile[section] && typeof lockfile[section] === "object",
			`Missing ${section}`,
		);
		const keys = Object.keys(lockfile[section]).filter((key) =>
			key.startsWith("@graphql-tools/utils@"),
		);
		assert.ok(keys.length > 0, `Missing utils ${section}`);
		for (const key of keys) {
			assert.ok(
				semver.gte(
					key.slice("@graphql-tools/utils@".length).split("(")[0],
					"12.0.3",
				),
				`Vulnerable utils: ${key}`,
			);
		}
	}
	for (const [section, owners] of [
		["importer", lockfile.importers],
		["snapshot", lockfile.snapshots],
	]) {
		assert.ok(owners && typeof owners === "object", `Missing ${section}`);
		for (const [owner, metadata] of Object.entries(owners)) {
			for (const group of [
				"dependencies",
				"devDependencies",
				"optionalDependencies",
			]) {
				for (const [name, dependency] of Object.entries(
					metadata[group] ?? {},
				)) {
					const reference =
						section === "importer"
							? dependency.version
							: dependency;
					const alias = "@graphql-tools/utils@";
					if (
						name === "@graphql-tools/utils" ||
						reference?.startsWith(alias) ||
						dependency.specifier?.startsWith(`npm:${alias}`)
					) {
						const version = reference
							?.replace(alias, "")
							.split("(")[0];
						assert.ok(
							semver.valid(version) &&
								semver.gte(version, "12.0.3"),
							`Vulnerable utils reference: ${owner}`,
						);
					}
				}
			}
		}
	}
}

test("all utils packages, snapshots and direct dependency groups require the supported fixed release", () => {
	const lockfile = yaml.parse(
		readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
	);
	verifyUtils(lockfile);
	for (const section of ["packages", "snapshots"]) {
		for (const version of ["10.10.1", "12.0.0", "12.0.2"]) {
			const bad = structuredClone(lockfile);
			bad[section][`@graphql-tools/utils@${version}`] = {};
			assert.throws(() => verifyUtils(bad), /Vulnerable utils/);
		}
		const bad = structuredClone(lockfile);
		delete bad[section];
		assert.throws(() => verifyUtils(bad));
	}
	for (const group of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
	]) {
		for (const [name, version] of [
			["@graphql-tools/utils", "10.10.1"],
			["utils-alias", "@graphql-tools/utils@12.0.0"],
		]) {
			const bad = structuredClone(lockfile);
			bad.importers["packages/example-consumer"] = {
				[group]: { [name]: { version } },
			};
			assert.throws(() => verifyUtils(bad), /Vulnerable utils reference/);
			bad.importers["packages/example-consumer"][group][name].version =
				name === "utils-alias"
					? "@graphql-tools/utils@12.0.3"
					: "12.0.3";
			assert.doesNotThrow(() => verifyUtils(bad));
		}
	}
});

test("every actual GraphQL parent declares and resolves compatible fixed utils", () => {
	for (const [name, version] of utilsConsumers) {
		for (const parent of installedConsumers(name, version)) {
			const actual = parent.require(
				"@graphql-tools/utils/package.json",
			).version;
			assert.ok(semver.gte(actual, "12.0.3"));
			assert.ok(
				semver.satisfies(
					actual,
					parent.manifest.dependencies["@graphql-tools/utils"],
				),
			);
		}
	}
});

function runChild(script, args = []) {
	const result = spawnSync(
		process.execPath,
		["--input-type=module", "-e", script, ...args],
		{
			encoding: "utf8",
			timeout: 3000,
			maxBuffer: 65536,
		},
	);
	assert.ifError(result.error);
	assert.equal(result.signal, null, result.stderr);
	assert.equal(result.status, 0, result.stderr || result.stdout);
}

for (const [name, version] of utilsConsumers) {
	test(`${name}: effective CJS and ESM mergeDeep reject prototype-chain merge keys`, async () => {
		for (const { require } of installedConsumers(name, version)) {
			assert.equal(
				require("@graphql-tools/utils/package.json").version,
				"12.1.0",
			);
			const cjs = require.resolve("@graphql-tools/utils");
			const esm = join(dirname(dirname(cjs)), "esm/index.js");
			// Each actual parent resolution is exercised in a process of its own,
			// including the advisory's Function.prototype path. An old package
			// cannot damage the test runner if the assertion detects pollution.
			for (const entry of [cjs, esm]) {
				runChild(
					`
					import assert from "node:assert/strict";
					const { mergeDeep } = await import(process.argv[1]);
					const marker = "fabricSecurityMergeProbe";
					for (const respectPrototype of [false, true]) {
						for (const key of ["__proto__", "constructor", "prototype"]) {
							const merged = mergeDeep([{ nested: { safe: 1 } }, JSON.parse('{"nested":{"' + key + '":{"' + marker + '":true},"ordinary":2}}')], respectPrototype);
							assert.equal(merged.nested.safe, 1);
							assert.equal(merged.nested.ordinary, 2);
							assert.equal(Object.hasOwn(merged.nested, key), false);
							assert.equal(merged.nested[marker], undefined);
						}
						mergeDeep([{}, JSON.parse('{"constructor":{"__proto__":{"' + marker + '":true}}}')], respectPrototype);
						assert.equal(Object.prototype[marker], undefined);
						assert.equal(Function.prototype[marker], undefined);
						// The own-property check must also avoid benign inherited
						// properties, beyond the three explicitly blocked keys.
						Object.defineProperty(Object.prototype, "inherited", { value: { previous: 1 }, writable: true, configurable: true });
						const ordinary = mergeDeep([{}, { inherited: { next: 2 } }], respectPrototype);
						assert.deepEqual(ordinary.inherited, { next: 2 });
						assert.deepEqual(Object.prototype.inherited, { previous: 1 });
						delete Object.prototype.inherited;
					}
				`,
					[pathToFileURL(entry).href],
				);
			}
		}
	});
	test(`${name}: ordinary merge options remain compatible in CJS and ESM`, async () => {
		for (const { require } of installedConsumers(name, version)) {
			const cjs = require.resolve("@graphql-tools/utils");
			for (const { mergeDeep } of [
				require("@graphql-tools/utils"),
				await import(
					pathToFileURL(join(dirname(dirname(cjs)), "esm/index.js"))
						.href
				),
			]) {
				assert.deepEqual(
					mergeDeep([
						{ nested: { a: 1 }, list: [1] },
						{ nested: { b: 2 }, list: [2] },
					]),
					{ nested: { a: 1, b: 2 }, list: [1, 2] },
				);
				assert.deepEqual(
					mergeDeep([{ list: [1] }, { list: [2] }], false, true),
					{ list: [1, 2] },
				);
				assert.deepEqual(
					mergeDeep([[{ a: 1 }], [{ b: 2 }]], false, true, true),
					[{ a: 1, b: 2 }],
				);
				assert.deepEqual(
					mergeDeep([[1], [2, 3]], false, true, true),
					[1, 2, 3],
				);
				class Resolver {
					method() {
						return "ordinary";
					}
				}
				const merged = mergeDeep([new Resolver(), { value: 2 }], true);
				assert.ok(merged instanceof Resolver);
				assert.equal(merged.method(), "ordinary");
				assert.equal(merged.value, 2);
			}
		}
	});
	test(`${name}: effective CJS and ESM mergeIncrementalResult reject unsafe path segments`, async () => {
		for (const { require } of installedConsumers(name, version)) {
			const cjs = require.resolve("@graphql-tools/utils");
			const esm = join(dirname(dirname(cjs)), "esm/index.js");
			// GHSA-c4qx-w738-7hr3: a non-primitive segment such as ["__proto__"]
			// passed the string-equality guard and coerced to "__proto__" on
			// access. Each resolution runs in a process of its own, as above.
			for (const entry of [cjs, esm]) {
				runChild(
					`
					import assert from "node:assert/strict";
					const { mergeIncrementalResult } = await import(process.argv[1]);
					const marker = "fabricSecurityIncrementalProbe";
					const unsafePaths = [
						[["__proto__"], marker],
						[{ toString: () => "__proto__" }, marker],
						["__proto__", marker],
						["constructor", "prototype", marker],
					];
					for (const path of unsafePaths) {
						const executionResult = { data: {} };
						mergeIncrementalResult({ executionResult, incrementalResult: { path, data: { polluted: true } } });
						mergeIncrementalResult({ executionResult, incrementalResult: { path: [...path, 0], items: [true] } });
						assert.equal(Object.prototype[marker], undefined);
						assert.equal(Object.prototype.polluted, undefined);
						assert.deepEqual(executionResult, { data: {} });
					}
					const executionResult = { data: { node: { a: 1 }, list: [{ id: 1 }] } };
					mergeIncrementalResult({ executionResult, incrementalResult: { path: ["node"], data: { b: 2 } } });
					mergeIncrementalResult({ executionResult, incrementalResult: { path: ["list", 1], items: [{ id: 2 }, { id: 3 }] } });
					mergeIncrementalResult({ executionResult, incrementalResult: { incremental: [{ path: ["node", "c"], data: { d: 4 } }] } });
					assert.deepEqual(executionResult, { data: { node: { a: 1, b: 2, c: { d: 4 } }, list: [{ id: 1 }, { id: 2 }, { id: 3 }] } });
				`,
					[pathToFileURL(entry).href],
				);
			}
		}
	});
}

test("GraphQL executor preserves variable-driven include and skip directives", async () => {
	for (const { require } of installedConsumers(
		"@graphql-tools/executor",
		"2.1.0",
	)) {
		const { execute } = require("@graphql-tools/executor");
		const { buildSchema, parse } = require("graphql");
		const schema = buildSchema(
			"type Query { item: Item } type Item { visible: String hidden: String }",
		);
		const document = parse(
			"query($show: Boolean!, $hide: Boolean!) { item @include(if: $show) { visible hidden @skip(if: $hide) } }",
		);
		const rootValue = { item: { visible: "yes", hidden: "no" } };
		for (const [show, hide, expected] of [
			[true, true, { item: { visible: "yes" } }],
			[true, false, rootValue],
			[false, true, {}],
		]) {
			const result = await execute({
				schema,
				document,
				rootValue,
				variableValues: { show, hide },
			});
			assert.equal(result.errors, undefined);
			assert.deepEqual(JSON.parse(JSON.stringify(result.data)), expected);
		}
	}
});
