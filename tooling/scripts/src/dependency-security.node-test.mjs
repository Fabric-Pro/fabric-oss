import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installedConsumers } from "./installed-consumers.mjs";
import "./chat-dependency-security.node-test.mjs";
import "./pg-instrumentation-security.node-test.mjs";
import "./graphql-security.node-test.mjs";
import "./dependency-upgrades.node-test.mjs";
import "./agent-cli-security.node-test.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
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

function verifyMetadata(lockfile) {
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

function runChild(script, args = []) {
	const result = spawnSync(
		process.execPath,
		["--input-type=module", "-e", script, ...args],
		{
			encoding: "utf8",
			timeout: 3000,
			maxBuffer: 65536,
			windowsHide: true,
		},
	);
	assert.ifError(result.error);
	assert.equal(result.signal, null, result.stderr);
	assert.equal(result.status, 0, result.stderr || result.stdout);
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

// Identity 4.14.1 accepts fixed MSAL >=7.1.0. The separate agents-hosting
// parent still pins 5.1.5. The OSV exception rests on two enforced facts: only
// that reviewed 5.x copy (or a fixed release) is locked, and no
// first-party code reaches the authorization-code flow the advisory affects.
function isReviewedMsalNodeVersion(version, semver) {
	return (
		semver.valid(version) !== null &&
		(version === "5.1.5" || semver.gte(version, "7.1.0"))
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
				`Unreviewed or vulnerable @azure/msal-node resolution: ${key} (${section}); GHSA-xcx6-jx8p-x3h5 permits only reviewed 5.1.5 or >=7.1.0`,
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

function firstPartyMsalAuthCodeHits(
	pattern = msalAuthCodeEntryPoints,
	cwd = root,
	noIndex = false,
) {
	return callSiteSearchHits(
		spawnSync(
			"git",
			[
				"grep",
				...(noIndex ? ["--no-index"] : []),
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
				":!tooling/scripts/src/dependency-upgrades.node-test.mjs",
			],
			{ cwd, encoding: "utf8", maxBuffer: 1 << 20 },
		),
	);
}

test("msal-node source search excludes only its reviewed security guards", () => {
	const artifacts = join(root, "artifacts");
	mkdirSync(artifacts, { recursive: true });
	const directory = mkdtempSync(join(artifacts, "msal-call-sites-"));
	const fixtures = {
		"tooling/scripts/src/dependency-security.node-test.mjs":
			'const fixture = "acquireTokenByCode";',
		"tooling/scripts/src/dependency-upgrades.node-test.mjs":
			'installedDependency(parent.require, "@azure/msal-node");',
		"apps/web/session.ts":
			'import { ConfidentialClientApplication } from "@azure/msal-node";',
		"packages/api/auth.ts":
			'client.acquireTokenByCode({ code: "synthetic" });',
		"apps/web/session.test.ts": "useIdentityPlugin(syntheticPlugin);",
	};
	try {
		for (const [path, source] of Object.entries(fixtures)) {
			const target = join(directory, path);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, source);
		}
		const hits = firstPartyMsalAuthCodeHits(undefined, directory, true);
		assert.equal(hits.length, 3);
		assert.ok(hits.some((hit) => hit.startsWith("apps/web/session.ts:")));
		assert.ok(hits.some((hit) => hit.startsWith("packages/api/auth.ts:")));
		assert.ok(
			hits.some((hit) => hit.startsWith("apps/web/session.test.ts:")),
		);
		assert.equal(
			hits.some((hit) => hit.startsWith("tooling/")),
			false,
		);
	} finally {
		assert.ok(directory.startsWith(join(artifacts, "msal-call-sites-")));
		rmSync(directory, { recursive: true });
	}
});

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
	for (const version of ["5.1.5", "7.1.0", "7.1.1", "8.0.0"]) {
		assert.equal(isReviewedMsalNodeVersion(version, semver), true, version);
	}
	for (const version of [
		"5.1.4",
		"5.2.1",
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

// GHSA-x8rm-f576-gq67: limit the ID-wide exception to reviewed resolutions.
function isReviewedGraphqlScalarsVersion(version, semver) {
	return (
		semver.valid(version) !== null &&
		!semver.prerelease(version) &&
		(version === "1.25.0" || semver.gte(version, "2.0.1"))
	);
}

function verifyGraphqlScalarsLockfile(text, yaml, semver) {
	assert.equal(typeof text, "string", "Missing readable lockfile text");
	const lockfile = yaml.parse(text);
	for (const section of ["packages", "snapshots"]) {
		assert.ok(
			lockfile?.[section] &&
				typeof lockfile[section] === "object" &&
				!Array.isArray(lockfile[section]),
			`Missing lockfile ${section}`,
		);
		const entries = Object.keys(lockfile[section]).filter((key) =>
			key.startsWith("graphql-scalars@"),
		);
		assert.ok(
			entries.length,
			`No graphql-scalars entries in lockfile ${section}`,
		);
		for (const key of entries) {
			const version = key.slice("graphql-scalars@".length).split("(")[0];
			assert.ok(
				isReviewedGraphqlScalarsVersion(version, semver),
				`Unreviewed or vulnerable graphql-scalars resolution: ${key} (${section})`,
			);
		}
	}
}

// PhoneNumber is reachable only through an import of the package itself, so
// the package name is the whole search; a bare PhoneNumber name elsewhere is
// unrelated first-party code.
function firstPartyGraphqlScalarsHits(pattern = "graphql-scalars") {
	return firstPartyMsalAuthCodeHits(pattern);
}

test("graphql-scalars exception permits reviewed or fixed stable versions", () => {
	const semver = installedConsumers("@changesets/cli", "3.0.1")[0].require(
		"semver",
	);
	for (const version of ["1.25.0", "2.0.1", "3.0.0"]) {
		assert.equal(isReviewedGraphqlScalarsVersion(version, semver), true);
	}
	for (const version of [
		"1.24.0",
		"2.0.0",
		"2.0.1-beta.1",
		"3.0.0-beta.1",
		"invalid",
	]) {
		assert.equal(isReviewedGraphqlScalarsVersion(version, semver), false);
	}
});

test("graphql-scalars lockfile guard rejects missing and unreviewed entries", () => {
	const yaml = installedConsumers("@changesets/parse", "1.0.0")[0].require(
		"yaml",
	);
	const semver = installedConsumers("@changesets/cli", "3.0.1")[0].require(
		"semver",
	);
	const snippet = (version) =>
		`packages:\n  'graphql-scalars@${version}': {}\nsnapshots:\n  'graphql-scalars@${version}': {}\n`;
	assert.doesNotThrow(() =>
		verifyGraphqlScalarsLockfile(snippet("2.0.1"), yaml, semver),
	);
	assert.throws(
		() => verifyGraphqlScalarsLockfile(snippet("2.0.0"), yaml, semver),
		/Unreviewed or vulnerable graphql-scalars resolution/,
	);
	for (const text of [
		"packages: [",
		"",
		"packages: {}\nsnapshots: {}",
		"packages: {}",
		"packages: null\nsnapshots: null",
	]) {
		assert.throws(() => verifyGraphqlScalarsLockfile(text, yaml, semver));
	}
	const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
	verifyGraphqlScalarsLockfile(lockfile, yaml, semver);
	for (const section of ["packages", "snapshots"]) {
		const mutated = yaml.parse(lockfile);
		const current = Object.keys(mutated[section]).find((key) =>
			key.startsWith("graphql-scalars@"),
		);
		assert.ok(current);
		mutated[section]["graphql-scalars@2.0.0"] = mutated[section][current];
		delete mutated[section][current];
		assert.throws(
			() =>
				verifyGraphqlScalarsLockfile(
					yaml.stringify(mutated),
					yaml,
					semver,
				),
			/Unreviewed or vulnerable graphql-scalars resolution: graphql-scalars@2\.0\.0/,
		);
	}
});

test("tracked first-party source does not import graphql-scalars", () => {
	assert.deepEqual(firstPartyGraphqlScalarsHits(), []);
	assert.ok(
		firstPartyGraphqlScalarsHits("@copilotkit/runtime").length > 0,
		"Search did not find a first-party CopilotKit import",
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

test("fixed proxy and source-map versions cover every lockfile consumer", () => {
	const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
	verifyMetadata(lockfile);
	for (const [name, version] of [
		["proxy-addr", "2.0.7"],
		["source-map-js", "1.2.1"],
	]) {
		assert.throws(() =>
			verifyMetadata(
				lockfile.replace(
					`${name}: ${name === "proxy-addr" ? "2.0.8" : "1.2.2"}`,
					`${name}: ${version}`,
				),
			),
		);
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
