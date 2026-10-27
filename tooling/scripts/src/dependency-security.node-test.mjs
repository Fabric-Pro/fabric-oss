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
// Reviewed backport of upstream commit 0b9529f1988fd36186a7c106a6efe0356f1b7f2e
// (mergeDeep) and of the setObjectKeyPath changes in upstream commits
// 20d36a5c6eb8fd5524420988e01a48618c450d70 and
// 19f5b3373fd7ace0688d19950fc529ce8347952a (mergeIncrementalResult).
const patchHash =
	"b529f122ce959d0691cbe9ff7c411d816b4e12858753cc52ad289f083878539a";
const utilsConsumers = [
	["@graphql-tools/executor", "1.4.11"],
	["@graphql-tools/merge", "9.1.3"],
	["@graphql-tools/schema", "10.0.27"],
	["@graphql-yoga/plugin-defer-stream", "3.16.2"],
	["graphql-yoga", "5.16.2"],
];
const proxyConsumers = [
	["express", "4.21.2"],
	["express", "5.2.1"],
];
const sourceMapConsumers = [
	["@tailwindcss/node", "4.1.16"],
	["css-tree", "3.2.1"],
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

function isReviewedZodVersion(version, semver) {
	return (
		semver.valid(version) !== null &&
		(version === "3.25.75" ||
			version === "3.25.76" ||
			semver.gte(version, "4.6.6"))
	);
}

function verifyZodLockfile(text, yaml, semver) {
	assert.equal(typeof text, "string", "Missing readable lockfile text");
	const lockfile = yaml.parse(text);
	for (const section of ["packages", "snapshots"]) {
		assert.ok(
			lockfile?.[section] && typeof lockfile[section] === "object",
			`Missing lockfile ${section}`,
		);
		const entries = Object.keys(lockfile[section]).filter((key) =>
			key.startsWith("zod@"),
		);
		assert.ok(entries.length > 0, `No zod entries in lockfile ${section}`);
		for (const key of entries) {
			const version = key.slice("zod@".length).split("(")[0];
			assert.ok(
				isReviewedZodVersion(version, semver),
				`Unreviewed or vulnerable zod resolution: ${key} (${section}); GHSA-mrhx-c7xc-m3w5 permits only reviewed 3.25.75/3.25.76 or >=4.6.6`,
			);
		}
	}
	const isMapping = (value) =>
		value !== null && typeof value === "object" && !Array.isArray(value);
	assert.ok(
		isMapping(lockfile.importers),
		"Missing readable lockfile importers",
	);
	assert.ok(
		Object.keys(lockfile.importers).length > 0,
		"Empty lockfile importers",
	);
	let zodImporters = 0;
	for (const [owner, metadata] of Object.entries(lockfile.importers)) {
		assert.ok(isMapping(metadata), `Unreadable importer ${owner}`);
		for (const group of [
			"dependencies",
			"devDependencies",
			"optionalDependencies",
		]) {
			if (!(group in metadata)) {
				continue;
			}
			assert.ok(
				isMapping(metadata[group]),
				`Unreadable importer ${owner} ${group}`,
			);
			if (!Object.hasOwn(metadata[group], "zod")) {
				continue;
			}
			zodImporters++;
			const dependency = metadata[group].zod;
			const version =
				isMapping(dependency) && typeof dependency.version === "string"
					? dependency.version.split("(")[0]
					: null;
			assert.ok(
				version !== null &&
					semver.valid(version) !== null &&
					semver.gte(version, "4.6.6"),
				`Invalid or vulnerable first-party zod resolution: ${owner} (${group}) ${JSON.stringify(dependency)}; require >=4.6.6`,
			);
		}
	}
	assert.ok(zodImporters > 0, "No zod dependencies in lockfile importers");
}

test("zod advisory exception accepts only reviewed v3 or versions at least 4.6.6", () => {
	const semver = installedConsumers("@changesets/cli", "3.0.1")[0].require(
		"semver",
	);
	for (const version of [
		"3.25.75",
		"3.25.76",
		"4.6.6",
		"4.6.7",
		"4.7.0",
		"5.0.0",
	]) {
		assert.equal(isReviewedZodVersion(version, semver), true, version);
	}
	for (const version of [
		"3.25.74",
		"3.25.77",
		"4.6.5",
		"4.6.6-rc.1",
		"invalid",
	]) {
		assert.equal(isReviewedZodVersion(version, semver), false, version);
	}
});

test("zod lockfile guard rejects vulnerable and unreviewed resolutions", () => {
	const yaml = installedConsumers("@changesets/parse", "1.0.0")[0].require(
		"yaml",
	);
	const semver = installedConsumers("@changesets/cli", "3.0.1")[0].require(
		"semver",
	);
	const snippet = (version) =>
		`importers:\n  example-package:\n    dependencies:\n      zod:\n        version: 4.6.7\npackages:\n  zod@${version}: {}\nsnapshots:\n  zod@${version}: {}\n`;
	assert.doesNotThrow(() =>
		verifyZodLockfile(snippet("4.6.6"), yaml, semver),
	);
	for (const version of ["4.6.5", "3.25.77"]) {
		assert.throws(
			() => verifyZodLockfile(snippet(version), yaml, semver),
			/Unreviewed or vulnerable zod resolution/,
		);
	}
	for (const text of [
		"packages: [",
		"",
		"packages: {}\nsnapshots: {}",
		"packages: {}",
		"packages: null\nsnapshots: null",
	]) {
		assert.throws(() => verifyZodLockfile(text, yaml, semver));
	}
});

test("first-party zod importers require at least 4.6.6 and readable metadata", () => {
	const yaml = installedConsumers("@changesets/parse", "1.0.0")[0].require(
		"yaml",
	);
	const semver = installedConsumers("@changesets/cli", "3.0.1")[0].require(
		"semver",
	);
	const fixture = (importers) =>
		yaml.stringify({
			packages: { "zod@3.25.76": {}, "zod@4.6.7": {} },
			snapshots: { "zod@3.25.76": {}, "zod@4.6.7": {} },
			importers,
		});
	for (const group of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
	]) {
		for (const version of [
			"4.6.6",
			"4.6.7",
			"4.7.0(peer@1.0.0)",
			"5.0.0",
		]) {
			assert.doesNotThrow(() =>
				verifyZodLockfile(
					fixture({
						"example-package": {
							[group]: { zod: { specifier: "*", version } },
						},
					}),
					yaml,
					semver,
				),
			);
		}
		for (const dependency of [
			{ version: "3.25.76" },
			{ version: "3.25.75" },
			{ version: "4.6.5" },
			{ version: "4.6.6-rc.1" },
			{ version: "invalid" },
			{ version: 4 },
			{},
			null,
			"4.6.7",
		]) {
			assert.throws(
				() =>
					verifyZodLockfile(
						fixture({
							"example-package": { [group]: { zod: dependency } },
						}),
						yaml,
						semver,
					),
				/first-party zod/,
			);
		}
		for (const metadata of [null, [], "unreadable"]) {
			assert.throws(
				() =>
					verifyZodLockfile(
						fixture({
							"example-package": { [group]: metadata },
						}),
						yaml,
						semver,
					),
				/importer/,
			);
		}
	}
	for (const importers of [
		undefined,
		null,
		{},
		[],
		"unreadable",
		{ "example-package": null },
		{ "example-package": {} },
	]) {
		assert.throws(
			() => verifyZodLockfile(fixture(importers), yaml, semver),
			/importer/,
		);
	}
});

test("zod advisory exception is limited to reviewed versions in the real lockfile", () => {
	const yaml = installedConsumers("@changesets/parse", "1.0.0")[0].require(
		"yaml",
	);
	const semver = installedConsumers("@changesets/cli", "3.0.1")[0].require(
		"semver",
	);
	// An unreadable lockfile throws here instead of silently skipping the guard.
	const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
	verifyZodLockfile(lockfile, yaml, semver);
	for (const section of ["packages", "snapshots"]) {
		const mutated = yaml.parse(lockfile);
		const current = Object.keys(mutated[section]).find((key) =>
			key.startsWith("zod@4."),
		);
		assert.ok(current, `Missing zod 4 resolution in ${section}`);
		mutated[section]["zod@4.6.5"] = mutated[section][current];
		delete mutated[section][current];
		assert.throws(
			() => verifyZodLockfile(yaml.stringify(mutated), yaml, semver),
			/Unreviewed or vulnerable zod resolution: zod@4\.6\.5/,
		);
	}
});

// GHSA-xcx6-jx8p-x3h5 is fixed only in @azure/msal-node 7.1.0, which neither
// @azure/identity 4.x (^6 at most) nor @microsoft/agents-hosting (exact 5.x
// pin) accepts. The OSV exception rests on two facts this file enforces: only
// the two reviewed 5.x copies (or a fixed release) are locked, and no
// first-party code reaches the authorization-code flow the advisory affects.
function isReviewedMsalNodeVersion(version, semver) {
	return (
		semver.valid(version) !== null &&
		(version === "5.1.5" ||
			version === "5.2.1" ||
			semver.gte(version, "7.1.0"))
	);
}

function verifyMsalNodeLockfile(text, yaml, semver) {
	assert.equal(typeof text, "string", "Missing readable lockfile text");
	const lockfile = yaml.parse(text);
	for (const section of ["packages", "snapshots"]) {
		assert.ok(
			lockfile?.[section] && typeof lockfile[section] === "object",
			`Missing lockfile ${section}`,
		);
		const entries = Object.keys(lockfile[section]).filter((key) =>
			key.startsWith("@azure/msal-node@"),
		);
		assert.ok(
			entries.length > 0,
			`No @azure/msal-node entries in lockfile ${section}`,
		);
		for (const key of entries) {
			const version = key.slice("@azure/msal-node@".length).split("(")[0];
			assert.ok(
				isReviewedMsalNodeVersion(version, semver),
				`Unreviewed or vulnerable @azure/msal-node resolution: ${key} (${section}); GHSA-xcx6-jx8p-x3h5 permits only reviewed 5.1.5/5.2.1 or >=7.1.0`,
			);
		}
	}
}

// The authorization-code entry points found in the installed packages:
// msal-node's own calls, the @azure/identity credentials that drive them, and
// the plugins that turn on the VS Code and broker credentials (which reach
// acquireTokenInteractive without naming it). DefaultAzureCredential is not
// listed; SECURITY.md records why its chain does not reach this flow while
// neither plugin is registered.
const msalAuthCodeEntryPoints =
	"acquireTokenByCode|acquireTokenInteractive|AuthorizationCodeCredential|InteractiveBrowserCredential|@azure/msal-node|@azure/identity-broker|@azure/identity-vscode|useIdentityPlugin";

// git grep exits 1 for "no match", but can also exit 1 after failing to read
// some files, so a clean "no match" needs an empty stderr too.
function callSiteSearchHits(result) {
	assert.ifError(result.error);
	assert.ok(
		(result.status === 0 || result.status === 1) && result.stderr === "",
		`git grep failed (${result.status}${result.signal ? `, ${result.signal}` : ""}): ${result.stderr}`,
	);
	return result.stdout.split("\n").filter(Boolean);
}

function firstPartyMsalAuthCodeHits(pattern = msalAuthCodeEntryPoints) {
	return callSiteSearchHits(
		spawnSync(
			"git",
			[
				"grep",
				"-nE",
				pattern,
				"--",
				"*.ts",
				"*.tsx",
				"*.mts",
				"*.cts",
				"*.js",
				"*.jsx",
				"*.mjs",
				"*.cjs",
				":!tooling/scripts/src/dependency-security.node-test.mjs",
			],
			{ cwd: root, encoding: "utf8", maxBuffer: 1 << 20 },
		),
	);
}

test("msal-node call-site search treats failed or partial searches as failures", () => {
	const ok = { error: undefined, signal: null, stderr: "" };
	assert.deepEqual(callSiteSearchHits({ ...ok, status: 1, stdout: "" }), []);
	assert.deepEqual(
		callSiteSearchHits({ ...ok, status: 0, stdout: "a.ts:1:x\n" }),
		["a.ts:1:x"],
	);
	for (const bad of [
		{ ...ok, status: 1, stdout: "", stderr: "fatal: unable to read a.ts" },
		{ ...ok, status: 0, stdout: "a.ts:1:x\n", stderr: "warning" },
		{ ...ok, status: 128, stdout: "" },
		{ ...ok, status: null, signal: "SIGTERM", stdout: "" },
		{
			...ok,
			status: null,
			stdout: "",
			error: new Error("spawn git ENOENT"),
		},
	]) {
		assert.throws(() => callSiteSearchHits(bad));
	}
});

test("msal-node advisory exception accepts only reviewed 5.x or versions at least 7.1.0", () => {
	const semver = installedConsumers("@changesets/cli", "3.0.1")[0].require(
		"semver",
	);
	for (const version of ["5.1.5", "5.2.1", "7.1.0", "7.1.1", "8.0.0"]) {
		assert.equal(isReviewedMsalNodeVersion(version, semver), true, version);
	}
	for (const version of [
		"5.1.4",
		"5.6.0",
		"6.0.0",
		"7.0.2",
		"7.1.0-beta.1",
		"invalid",
	]) {
		assert.equal(
			isReviewedMsalNodeVersion(version, semver),
			false,
			version,
		);
	}
});

test("msal-node lockfile guard rejects vulnerable and unreviewed resolutions", () => {
	const yaml = installedConsumers("@changesets/parse", "1.0.0")[0].require(
		"yaml",
	);
	const semver = installedConsumers("@changesets/cli", "3.0.1")[0].require(
		"semver",
	);
	const snippet = (version) =>
		`packages:\n  '@azure/msal-node@${version}': {}\nsnapshots:\n  '@azure/msal-node@${version}': {}\n`;
	assert.doesNotThrow(() =>
		verifyMsalNodeLockfile(snippet("7.1.0"), yaml, semver),
	);
	for (const version of ["5.6.0", "6.0.0", "7.0.2"]) {
		assert.throws(
			() => verifyMsalNodeLockfile(snippet(version), yaml, semver),
			/Unreviewed or vulnerable @azure\/msal-node resolution/,
		);
	}
	for (const text of [
		"packages: [",
		"",
		"packages: {}\nsnapshots: {}",
		"packages: {}",
		"packages: null\nsnapshots: null",
	]) {
		assert.throws(() => verifyMsalNodeLockfile(text, yaml, semver));
	}
});

test("msal-node advisory exception is limited to reviewed versions in the real lockfile", () => {
	const yaml = installedConsumers("@changesets/parse", "1.0.0")[0].require(
		"yaml",
	);
	const semver = installedConsumers("@changesets/cli", "3.0.1")[0].require(
		"semver",
	);
	// An unreadable lockfile throws here instead of silently skipping the guard.
	const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
	verifyMsalNodeLockfile(lockfile, yaml, semver);
	for (const section of ["packages", "snapshots"]) {
		const mutated = yaml.parse(lockfile);
		const current = Object.keys(mutated[section]).find((key) =>
			key.startsWith("@azure/msal-node@"),
		);
		assert.ok(current, `Missing @azure/msal-node resolution in ${section}`);
		mutated[section]["@azure/msal-node@6.0.0"] = mutated[section][current];
		delete mutated[section][current];
		assert.throws(
			() => verifyMsalNodeLockfile(yaml.stringify(mutated), yaml, semver),
			/Unreviewed or vulnerable @azure\/msal-node resolution: @azure\/msal-node@6\.0\.0/,
		);
	}
});

test("no first-party code reaches the msal-node authorization-code flow", () => {
	assert.deepEqual(firstPartyMsalAuthCodeHits(), []);
	// The search itself must be able to find a call site: the one in
	// @azure/identity's DefaultAzureCredential import proves it reads sources.
	assert.ok(
		firstPartyMsalAuthCodeHits("DefaultAzureCredential").length > 0,
		"git grep found no DefaultAzureCredential import; the call-site search is not reading first-party sources",
	);
});

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

// pnpm applies `patchedDependencies` only when the patch files are present at
// install time, so every Docker stage that installs must copy `patches/` first
// or the image silently ships the unpatched registry code.
function verifyDockerfile(source, path) {
	const stages = new Map();
	let hasPatches = false;
	let stageName;
	for (const line of source.replace(/\\\n\s*/g, " ").split("\n")) {
		const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
		if (from) {
			hasPatches = stages.get(from[1]) === true;
			stageName = from[2];
		}
		const copy =
			/^COPY\s+(?:--from=(\S+)\s+)?(?:\/app\/)?patches\s+\.\/patches\/?\s*$/i.exec(
				line,
			);
		if (copy) {
			assert.ok(
				!copy[1] || stages.get(copy[1]),
				`${path}: patch source stage must contain patches`,
			);
			hasPatches = true;
		}
		if (/^RUN\s.*\bpnpm\s+(?:install|fetch)\b/.test(line)) {
			assert.ok(
				hasPatches,
				`${path}: copy patches before pnpm install/fetch in every stage`,
			);
		}
		if (stageName) {
			stages.set(stageName, hasPatches);
		}
	}
}

function dockerfiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (
			entry.name.startsWith(".") ||
			["node_modules", "__fixtures__"].includes(entry.name)
		) {
			return [];
		}
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			return dockerfiles(path);
		}
		return entry.isFile() && entry.name.startsWith("Dockerfile")
			? [path]
			: [];
	});
}

test("all Docker pnpm install stages receive the patches directory", () => {
	const files = dockerfiles(root);
	assert.ok(files.length > 0);
	for (const path of files) {
		verifyDockerfile(readFileSync(path, "utf8"), path);
	}
	const fixture =
		"FROM node:22 AS builder\nCOPY patches ./patches\nRUN pnpm install\nFROM node:22 AS runtime\nCOPY --from=builder /app/patches ./patches\nRUN pnpm install --prod\n";
	verifyDockerfile(fixture, "fixture");
	assert.throws(() =>
		verifyDockerfile(
			fixture.replace("COPY patches ./patches\n", ""),
			"fixture",
		),
	);
	assert.throws(() =>
		verifyDockerfile(
			fixture.replace("COPY --from=builder /app/patches ./patches\n", ""),
			"fixture",
		),
	);
});
