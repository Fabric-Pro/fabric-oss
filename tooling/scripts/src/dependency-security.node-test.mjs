import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const patchPath = "patches/@graphql-tools__utils@10.10.1.patch";
// Reviewed backport of upstream commit 0b9529f1988fd36186a7c106a6efe0356f1b7f2e.
const patchHash =
	"d20fc7fa1ff651691ab252c082cc06dec88f1e8250b04b9b299107ed56bb56be";
const utilsConsumers = [
	["@graphql-tools/executor", "1.4.11"],
	["@graphql-tools/merge", "9.1.3"],
	["@graphql-tools/schema", "10.0.27"],
	["@graphql-yoga/plugin-defer-stream", "3.16.2"],
	["graphql-yoga", "5.16.2"],
];
const proxyConsumers = [
	["express", "4.21.2"],
	["express", "5.1.0"],
	["express", "5.2.1"],
];
const sourceMapConsumers = [
	["@tailwindcss/node", "4.1.16"],
	["css-tree", "3.2.1"],
	["magicast", "0.3.5"],
	["magicast", "0.5.3"],
	["postcss", "8.5.26"],
	["sass", "1.51.0"],
	["source-map-loader", "5.0.0"],
];

function patchBlock(text) {
	const block = /^patchedDependencies:\n((?:[ \t]+[^\n]*(?:\n|$))*)/m.exec(
		text,
	);
	assert.ok(block, "Missing patchedDependencies block");
	return block[1];
}

function verifyMetadata(workspace, lockfile, patch) {
	assert.ok(
		patchBlock(workspace).includes(
			`  '@graphql-tools/utils@10.10.1': ${patchPath}\n`,
		),
		"Register the exact-version GraphQL utils patch",
	);
	assert.equal(createHash("sha256").update(patch).digest("hex"), patchHash);
	assert.ok(
		patchBlock(lockfile).includes(
			`  '@graphql-tools/utils@10.10.1': ${patchHash}\n`,
		),
		"The lockfile must record the reviewed patch hash",
	);
	const yaml = installedConsumers("@changesets/parse", "1.0.0")[0].require(
		"yaml",
	);
	const parsedLockfile = yaml.parse(lockfile);
	const utilsName = "@graphql-tools/utils";
	const reviewedReference = `10.10.1(patch_hash=${patchHash})(graphql@16.14.2)`;
	assert.deepEqual(
		Object.keys(parsedLockfile.packages).filter((key) =>
			key.startsWith(`${utilsName}@`),
		),
		[`${utilsName}@10.10.1`],
		"Only the reviewed utils package version may use the advisory exception",
	);
	assert.deepEqual(
		Object.keys(parsedLockfile.snapshots).filter((key) =>
			key.startsWith(`${utilsName}@`),
		),
		[`${utilsName}@${reviewedReference}`],
		"Every utils snapshot must resolve the reviewed patch",
	);
	for (const [section, owners] of [
		["importer", parsedLockfile.importers],
		["snapshot", parsedLockfile.snapshots],
	]) {
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
					if (
						name === utilsName ||
						reference?.startsWith(`${utilsName}@`) ||
						dependency.specifier?.startsWith(`npm:${utilsName}@`)
					) {
						assert.equal(
							reference?.replace(`${utilsName}@`, ""),
							reviewedReference,
							`Every utils ${section} reference must resolve the reviewed patch: ${owner}`,
						);
					}
				}
			}
		}
	}
	const references = [
		...lockfile.matchAll(/^ {6}'@graphql-tools\/utils': (.+)$/gm),
	];
	assert.equal(references.length, utilsConsumers.length);
	for (const [, reference] of references) {
		assert.equal(
			reference,
			`10.10.1(patch_hash=${patchHash})(graphql@16.14.2)`,
		);
	}
	for (const [name, version] of utilsConsumers) {
		const escaped = `${name}@${version}`.replace(
			/[.*+?^${}()|[\]\\]/g,
			"\\$&",
		);
		assert.ok(
			new RegExp(
				`^  '?${escaped}\\([^\\n]+\\)'?:\\n(?: {4,}[^\\n]*\\n)*? {6}'@graphql-tools/utils': 10\\.10\\.1\\(patch_hash=${patchHash}\\)\\(graphql@16\\.14\\.2\\)$`,
				"m",
			).test(lockfile),
			`${name}@${version} must resolve the reviewed patch`,
		);
	}
	assert.ok(
		lockfile.includes(
			`  '@graphql-tools/utils@10.10.1(patch_hash=${patchHash})(graphql@16.14.2)':`,
		),
	);
	for (const [name, version, consumers] of [
		["proxy-addr", "2.0.8", proxyConsumers],
		["source-map-js", "1.2.2", sourceMapConsumers],
	]) {
		const references = [
			...lockfile.matchAll(new RegExp(`^ {6}${name}: (.+)$`, "gm")),
		];
		assert.equal(
			references.length,
			consumers.length,
			`Missing ${name} consumers`,
		);
		for (const [, reference] of references) {
			assert.equal(reference, version);
		}
		for (const [, resolved] of lockfile.matchAll(
			new RegExp(`^ {2}${name}@([0-9][^:]+):`, "gm"),
		)) {
			assert.equal(resolved, version);
		}
	}
}

function installedConsumers(name, version) {
	const store = join(root, "node_modules/.pnpm");
	const prefix = `${name.replaceAll("/", "+")}@${version}`;
	const entries = readdirSync(store).filter(
		(value) => value === prefix || value.startsWith(`${prefix}_`),
	);
	assert.ok(
		entries.length > 0,
		`Missing installed ${name}@${version}; run pnpm install --frozen-lockfile`,
	);
	return entries.map((entry) => {
		const manifestPath = join(
			store,
			entry,
			"node_modules",
			name,
			"package.json",
		);
		return {
			require: createRequire(manifestPath),
			manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
		};
	});
}

function verifyParentRange(semver, manifest, dependency, version) {
	const range =
		manifest.dependencies?.[dependency] ??
		manifest.optionalDependencies?.[dependency];
	assert.equal(
		typeof range,
		"string",
		`${manifest.name} must declare ${dependency}`,
	);
	assert.ok(
		semver.satisfies(version, range),
		`${manifest.name}@${manifest.version} requires ${dependency}@${range}, incompatible with the locked security version ${version}`,
	);
}

test("each immediate parent's original range accepts the locked security version", () => {
	const semver = installedConsumers("@changesets/cli", "3.0.1")[0].require(
		"semver",
	);
	for (const [dependency, version, consumers] of [
		["proxy-addr", "2.0.8", proxyConsumers],
		["source-map-js", "1.2.2", sourceMapConsumers],
	]) {
		for (const [name, parentVersion] of consumers) {
			for (const { require, manifest } of installedConsumers(
				name,
				parentVersion,
			)) {
				verifyParentRange(semver, manifest, dependency, version);
				assert.equal(
					require(`${dependency}/package.json`).version,
					version,
				);
				assert.throws(() =>
					verifyParentRange(
						semver,
						{
							...manifest,
							dependencies: {
								...manifest.dependencies,
								[dependency]: "^3.0.0",
							},
						},
						dependency,
						version,
					),
				);
			}
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

test("reviewed utils patch and fixed dependency versions cover every lockfile consumer", () => {
	const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
	const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
	const patch = readFileSync(join(root, patchPath));
	verifyMetadata(workspace, lockfile, patch);
	for (const [badWorkspace, badLockfile, badPatch] of [
		[
			workspace.replace("patchedDependencies:", "removed:"),
			lockfile,
			patch,
		],
		[
			workspace,
			lockfile.replace("patchedDependencies:", "removed:"),
			patch,
		],
		[
			workspace,
			lockfile.replace(
				`10.10.1(patch_hash=${patchHash})(graphql@16.14.2)`,
				"10.10.1(graphql@16.14.2)",
			),
			patch,
		],
		[workspace, lockfile.replaceAll(patchHash, "removed"), patch],
		[workspace, lockfile, Buffer.concat([patch, Buffer.from("changed")])],
		[
			workspace,
			lockfile.replace("proxy-addr: 2.0.8", "proxy-addr: 2.0.7"),
			patch,
		],
		[
			workspace,
			lockfile.replace("source-map-js: 1.2.2", "source-map-js: 1.2.1"),
			patch,
		],
	]) {
		assert.throws(() =>
			verifyMetadata(badWorkspace, badLockfile, badPatch),
		);
	}
});

test("the advisory exception cannot hide an additional unpatched direct utils dependency", async (t) => {
	const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
	const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
	const patch = readFileSync(join(root, patchPath));
	for (const version of ["10.10.1", "12.0.0"]) {
		const reference = `${version}(graphql@16.14.2)`;
		let additionalDependency = lockfile.replace(
			/^importers:\n/m,
			`importers:\n\n  packages/example-utils-consumer:\n    dependencies:\n      '@graphql-tools/utils':\n        specifier: ${version}\n        version: ${reference}\n`,
		);
		if (version !== "10.10.1") {
			additionalDependency = additionalDependency.replace(
				/^packages:\n/m,
				`packages:\n\n  '@graphql-tools/utils@${version}':\n    resolution: {integrity: sha512-ZXhhbXBsZQ==}\n    peerDependencies:\n      graphql: ^16.0.0\n`,
			);
		}
		additionalDependency = additionalDependency.replace(
			/^snapshots:\n/m,
			`snapshots:\n\n  '@graphql-tools/utils@${reference}':\n    dependencies:\n      graphql: 16.14.2\n`,
		);
		await t.test(`unpatched direct utils@${version}`, () => {
			assert.throws(
				() => verifyMetadata(workspace, additionalDependency, patch),
				`An additional unpatched direct utils@${version} must fail the exception check`,
			);
		});
	}
});

test("all direct importer dependency groups require the reviewed utils reference", () => {
	const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
	const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
	const patch = readFileSync(join(root, patchPath));
	const reviewedReference = `10.10.1(patch_hash=${patchHash})(graphql@16.14.2)`;
	for (const group of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
	]) {
		const directImporter = lockfile.replace(
			/^importers:\n/m,
			`importers:\n\n  packages/example-utils-consumer:\n    ${group}:\n      '@graphql-tools/utils':\n        specifier: 10.10.1\n        version: ${reviewedReference}\n`,
		);
		assert.doesNotThrow(() =>
			verifyMetadata(workspace, directImporter, patch),
		);
		assert.throws(
			() =>
				verifyMetadata(
					workspace,
					directImporter.replace(
						`version: ${reviewedReference}`,
						"version: 10.10.1(graphql@16.14.2)",
					),
					patch,
				),
			/Every utils importer reference must resolve the reviewed patch/,
		);
	}
});

for (const [name, version] of utilsConsumers) {
	test(`${name}: effective CJS and ESM mergeDeep reject prototype-chain merge keys`, async () => {
		for (const { require } of installedConsumers(name, version)) {
			assert.equal(
				require("@graphql-tools/utils/package.json").version,
				"10.10.1",
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
}

test("GraphQL executor preserves variable-driven include and skip directives", async () => {
	for (const { require } of installedConsumers(
		"@graphql-tools/executor",
		"1.4.11",
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

for (const [name, version] of proxyConsumers) {
	test(`${name}@${version}: mapped trust subnets do not trust arbitrary IPv4 clients`, () => {
		for (const { require } of installedConsumers(name, version)) {
			const proxyaddr = require("proxy-addr");
			for (const subnet of ["::ffff:10.0.0.0/8", "::/1"]) {
				const trust = proxyaddr.compile(subnet);
				assert.equal(trust("192.0.2.42"), false);
				assert.equal(
					proxyaddr(
						{
							socket: { remoteAddress: "192.0.2.42" },
							headers: { "x-forwarded-for": "198.51.100.7" },
						},
						trust,
					),
					"192.0.2.42",
				);
			}
			for (const subnet of ["::ffff:10.0.0.0/104", "10.0.0.0/8"]) {
				const trust = proxyaddr.compile(subnet);
				assert.equal(trust("10.1.2.3"), true);
				assert.equal(trust("::ffff:10.1.2.3"), true);
				assert.equal(trust("192.0.2.42"), false);
				assert.equal(
					proxyaddr(
						{
							socket: { remoteAddress: "10.1.2.3" },
							headers: { "x-forwarded-for": "198.51.100.7" },
						},
						trust,
					),
					"198.51.100.7",
				);
			}
		}
	});
}

for (const [name, version] of sourceMapConsumers) {
	test(`${name}@${version}: indexed source maps reject oversized and invalid offsets within a bound`, () => {
		for (const { require } of installedConsumers(name, version)) {
			runChild(
				`
				import assert from "node:assert/strict";
				import { createRequire } from "node:module";
				const { SourceMapConsumer, SourceMapGenerator } = createRequire(process.argv[1])("source-map-js");
				const basic = { version: 3, sources: ["example.js"], names: [], mappings: "AAAA", sourcesContent: ["x"] };
				const indexed = (line, column = 0, map = basic) => ({ version: 3, sections: [{ offset: { line, column }, map }] });
				const convert = (map) => {
					const consumer = new SourceMapConsumer(map);
					const generator = new SourceMapGenerator();
					consumer.eachMapping((mapping) => generator.addMapping({ source: mapping.source, original: { line: mapping.originalLine, column: mapping.originalColumn }, generated: { line: mapping.generatedLine, column: mapping.generatedColumn } }));
					return generator.toString();
				};
				for (const line of [1e12, Infinity, NaN, -1, 0.5, "1"]) {
					assert.throws(() => convert(indexed(line)), /Section offset line/);
				}
				for (const column of [Infinity, NaN, -1, 0.5, "1"]) {
					assert.throws(() => convert(indexed(0, column)), /Section offset line and column/);
				}
				assert.throws(() => convert(indexed(6000000, 0, indexed(6000000))), /including offsets of nested sections/);
				const consumer = new SourceMapConsumer(JSON.parse(convert(indexed(2))));
				assert.deepEqual(consumer.originalPositionFor({ line: 3, column: 0 }), { source: "example.js", line: 1, column: 0, name: null });
				assert.equal(JSON.parse(convert(indexed(2))).mappings, ";;AAAA");
				assert.equal(JSON.parse(convert(basic)).mappings, "AAAA");
			`,
				[require.resolve("source-map-js")],
			);
		}
	});
}
