import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { installedConsumers } from "./installed-consumers.mjs";
import {
	addPackage,
	assertRejectsMalformed,
	entriesNamed,
	isStableAtLeast,
	mutableCopy,
	readLockfile,
	referencesTo,
	requireLockfile,
	semver,
	validateLockfile,
} from "./lockfile-shape.mjs";

const utilsConsumers = [
	["@graphql-tools/executor", "2.1.0"],
	["@graphql-tools/merge", "9.2.6"],
	["@graphql-tools/schema", "10.1.3"],
	["@graphql-yoga/plugin-defer-stream", "3.24.4"],
	["graphql-yoga", "5.24.4"],
];
const utilsName = "@graphql-tools/utils";

function verifyUtils(lockfile) {
	requireLockfile(lockfile);
	for (const section of ["packages", "snapshots"]) {
		const entries = entriesNamed(lockfile, section, utilsName);
		assert.ok(entries.length > 0, `Missing utils ${section}`);
		for (const { key, version } of entries) {
			assert.ok(
				isStableAtLeast(version, "12.0.3"),
				`Vulnerable utils: ${key}`,
			);
		}
	}
	// Direct and aliased references alike: a reference named utils must
	// resolve to utils itself, and an alias resolves through its target.
	for (const reference of referencesTo(lockfile, utilsName)) {
		assert.ok(
			reference.target?.name === utilsName &&
				isStableAtLeast(reference.target.version, "12.0.3"),
			`Vulnerable utils reference: ${reference.owner}`,
		);
	}
}

test("all utils packages, snapshots and direct dependency groups require the supported fixed release", () => {
	const lockfile = readLockfile();
	verifyUtils(lockfile);
	assertRejectsMalformed(verifyUtils, lockfile);
	for (const version of ["10.10.1", "12.0.0", "12.0.2", "12.1.1-rc.0"]) {
		const bad = addPackage(
			mutableCopy(lockfile),
			`${utilsName}@${version}`,
		);
		assert.throws(
			() => verifyUtils(validateLockfile(bad)),
			/Vulnerable utils: /,
			version,
		);
	}
	for (const section of ["packages", "snapshots"]) {
		const bad = mutableCopy(lockfile);
		delete bad[section];
		assert.throws(
			() => verifyUtils(validateLockfile(bad)),
			/could not check/,
		);
	}
	for (const group of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
	]) {
		// Every registry reference names an existing snapshot, which the entry
		// check already covers; the reference check adds `file:` copies and
		// names that resolve to another package.
		for (const [name, specifier, version, fixed, expected] of [
			[
				utilsName,
				"file:vendor/utils",
				"file:vendor/utils",
				"12.0.3",
				/Vulnerable utils reference/,
			],
			[
				"utils-alias",
				`npm:${utilsName}@^12.0.0`,
				`${utilsName}@12.0.0`,
				`${utilsName}@12.0.3`,
				/Vulnerable utils: /,
			],
			[
				utilsName,
				"npm:example-utils@^12.0.0",
				"example-utils@12.0.3",
				"12.0.3",
				/Vulnerable utils reference/,
			],
		]) {
			const bad = mutableCopy(lockfile);
			for (const key of [
				`${utilsName}@12.0.0`,
				`${utilsName}@12.0.3`,
				"example-utils@12.0.3",
			]) {
				addPackage(bad, key);
			}
			delete bad.packages[`${utilsName}@12.0.0`];
			delete bad.snapshots[`${utilsName}@12.0.0`];
			if (name === "utils-alias") {
				addPackage(bad, `${utilsName}@12.0.0`);
			}
			bad.importers["packages/example-consumer"] = {
				[group]: { [name]: { specifier, version } },
			};
			assert.throws(
				() => verifyUtils(validateLockfile(bad)),
				expected,
				`${name} ${version}`,
			);
			bad.importers["packages/example-consumer"][group][name] = {
				specifier: "^12.0.0",
				version: fixed,
			};
			if (name === "utils-alias") {
				delete bad.packages[`${utilsName}@12.0.0`];
				delete bad.snapshots[`${utilsName}@12.0.0`];
				bad.importers["packages/example-consumer"][group][
					name
				].specifier = `npm:${utilsName}@^12.0.0`;
			}
			assert.doesNotThrow(() => verifyUtils(validateLockfile(bad)));
			// An alias specifier whose version names another package, or a
			// specifier the reader cannot read, is not skipped.
			bad.importers["packages/example-consumer"][group][name] = {
				specifier: `npm:${utilsName}@^12.0.0`,
				version: "example-utils@12.0.3",
			};
			assert.throws(
				() => verifyUtils(validateLockfile(bad)),
				/could not check: .* does not match version example-utils@12\.0\.3/,
			);
			bad.importers["packages/example-consumer"][group][name].specifier =
				12;
			assert.throws(
				() => verifyUtils(validateLockfile(bad)),
				/could not check: .* specifier is not a non-empty string/,
			);
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
