import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installedConsumers } from "./installed-consumers.mjs";
import {
	addPackage,
	assertRejectsMalformed,
	entriesNamed,
	isStableAtLeast,
	isStableVersion,
	mutableCopy,
	parseLockfile,
	readLockfile,
	referencesTo,
	requireLockfile,
	semver,
	syntheticLockfile,
	validateLockfile,
} from "./lockfile-shape.mjs";
import "./lockfile-shape.node-test.mjs";
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

/** A reference's version, failing unless it resolves to `name` itself. */
function referencedVersion(reference, name) {
	assert.ok(
		reference.target?.name === name,
		`Unreviewed ${name} reference from ${reference.owner}: ${reference.reference}`,
	);
	return reference.target.version;
}

// Every proxy-addr and source-map-js copy is the fixed version, and exactly the
// reviewed parents reference it.
function verifyMetadata(lockfile) {
	requireLockfile(lockfile);
	for (const [name, version, consumers] of [
		["proxy-addr", "2.0.8", proxyConsumers],
		["source-map-js", "1.2.2", sourceMapConsumers],
	]) {
		for (const section of ["packages", "snapshots"]) {
			const entries = entriesNamed(lockfile, section, name);
			assert.ok(entries.length > 0, `Missing ${name} ${section}`);
			for (const entry of entries) {
				assert.equal(
					entry.version,
					version,
					`${entry.key} (${section})`,
				);
			}
		}
		const parents = new Set();
		for (const reference of referencesTo(lockfile, name)) {
			assert.equal(
				referencedVersion(reference, name),
				version,
				`${name} reference from ${reference.owner}`,
			);
			parents.add(
				reference.section === "importers"
					? reference.owner
					: `${reference.ownerName}@${reference.ownerVersion}`,
			);
		}
		assert.deepEqual(
			[...parents].sort(),
			consumers
				.map(([parent, parentVersion]) => `${parent}@${parentVersion}`)
				.sort(),
			`Missing or unreviewed ${name} consumers`,
		);
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
// A prerelease never satisfies a range, so this check fails closed on one.
function verifyParentRange(manifest, dependency, version) {
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

function isReviewedZodVersion(version) {
	return (
		isStableVersion(version) &&
		(version === "3.25.75" ||
			version === "3.25.76" ||
			semver.gte(version, "4.6.6"))
	);
}

function verifyZodLockfile(lockfile) {
	requireLockfile(lockfile);
	for (const section of ["packages", "snapshots"]) {
		const entries = entriesNamed(lockfile, section, "zod");
		assert.ok(entries.length > 0, `No zod entries in lockfile ${section}`);
		for (const { key, version } of entries) {
			assert.ok(
				isReviewedZodVersion(version),
				`Unreviewed or vulnerable zod resolution: ${key} (${section}); GHSA-mrhx-c7xc-m3w5 permits only reviewed 3.25.75/3.25.76 or >=4.6.6`,
			);
		}
	}
	const importers = referencesTo(lockfile, "zod").filter(
		(reference) => reference.section === "importers",
	);
	assert.ok(
		importers.length > 0,
		"No zod dependencies in lockfile importers",
	);
	for (const reference of importers) {
		assert.ok(
			reference.target?.name === "zod" &&
				isStableAtLeast(reference.target.version, "4.6.6"),
			`Invalid or vulnerable first-party zod resolution: ${reference.owner} (${reference.group}) ${reference.reference}; require >=4.6.6`,
		);
	}
}

function zodSnippet(version, importerVersion = "4.6.7") {
	return parseLockfile(
		syntheticLockfile({
			importers: {
				"example-package": {
					dependencies: {
						zod: { specifier: "^4.6.6", version: importerVersion },
					},
				},
			},
			packages: { [`zod@${version}`]: {} },
			snapshots: { [`zod@${version}`]: {} },
		}),
	);
}

test("zod advisory exception accepts only reviewed v3 or stable versions at least 4.6.6", () => {
	for (const version of [
		"3.25.75",
		"3.25.76",
		"4.6.6",
		"4.6.7",
		"4.7.0",
		"5.0.0",
	]) {
		assert.equal(isReviewedZodVersion(version), true, version);
	}
	for (const version of [
		"3.25.74",
		"3.25.77",
		"4.6.5",
		"4.6.6-rc.1",
		"4.7.0-beta.1",
		"invalid",
	]) {
		assert.equal(isReviewedZodVersion(version), false, version);
	}
});

test("zod lockfile guard rejects vulnerable and unreviewed resolutions", () => {
	assert.doesNotThrow(() => verifyZodLockfile(zodSnippet("4.6.6")));
	for (const version of ["4.6.5", "3.25.77", "4.7.0-beta.1"]) {
		assert.throws(
			() => verifyZodLockfile(zodSnippet(version)),
			/Unreviewed or vulnerable zod resolution/,
			version,
		);
	}
	assert.throws(
		() =>
			verifyZodLockfile(
				parseLockfile(
					syntheticLockfile({
						packages: { "other@1.0.0": {} },
						snapshots: { "other@1.0.0": {} },
					}),
				),
			),
		/No zod entries/,
	);
	for (const text of [
		"packages: [",
		"",
		"packages: {}\nsnapshots: {}",
		"packages: {}",
		"packages: null\nsnapshots: null",
	]) {
		assert.throws(
			() => verifyZodLockfile(parseLockfile(text)),
			/could not check/,
			text,
		);
	}
});

test("first-party zod importers require a stable version at least 4.6.6 and readable metadata", () => {
	const fixture = (importers) =>
		syntheticLockfile({
			packages: { "zod@3.25.76": {}, "zod@4.6.7": {} },
			snapshots: { "zod@3.25.76": {}, "zod@4.6.7": {} },
			importers,
		});
	for (const group of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
	]) {
		const importer = (dependencies) =>
			fixture({ "example-package": { [group]: dependencies } });
		for (const version of [
			"4.6.6",
			"4.6.7",
			"4.7.0(peer@1.0.0)",
			"5.0.0",
		]) {
			assert.doesNotThrow(() =>
				verifyZodLockfile(
					parseLockfile(
						importer({ zod: { specifier: "*", version } }),
					),
				),
			);
		}
		for (const dependencies of [
			// The fixture keeps package and snapshot copies of each referenced
			// version, so these reach the importer check only when the copy
			// itself is reviewed (3.25.x); 4.6.5 and the prerelease fail on
			// their package record first.
			{ zod: { specifier: "*", version: "3.25.76" } },
			{ zod: { specifier: "*", version: "3.25.75" } },
			{ zod: { specifier: "*", version: "link:../zod" } },
			{ "zod-alias": { specifier: "npm:zod@3", version: "zod@3.25.76" } },
		]) {
			assert.throws(
				() => verifyZodLockfile(parseLockfile(importer(dependencies))),
				/first-party zod/,
				JSON.stringify(dependencies),
			);
		}
		for (const version of ["4.6.5", "4.6.6-rc.1"]) {
			assert.throws(
				() =>
					verifyZodLockfile(
						parseLockfile(
							importer({ zod: { specifier: "*", version } }),
						),
					),
				/Unreviewed or vulnerable zod resolution/,
				version,
			);
		}
		for (const dependency of [
			{ version: "3.25.76" },
			{ specifier: "*", version: "invalid" },
			{ specifier: "*", version: 4 },
			{ specifier: 4, version: "4.6.7" },
			{},
			null,
			"4.6.7",
		]) {
			assert.throws(
				() =>
					verifyZodLockfile(
						parseLockfile(importer({ zod: dependency })),
					),
				/could not check/,
				JSON.stringify(dependency),
			);
		}
		for (const metadata of [null, [], "unreadable"]) {
			assert.throws(
				() => verifyZodLockfile(parseLockfile(importer(metadata))),
				/could not check/,
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
	]) {
		const raw = {
			lockfileVersion: "9.0",
			packages: { "zod@4.6.7": {} },
			snapshots: { "zod@4.6.7": {} },
		};
		if (importers !== undefined) {
			raw.importers = importers;
		}
		assert.throws(
			() => verifyZodLockfile(validateLockfile(raw)),
			/could not check/,
			JSON.stringify(importers),
		);
	}
	assert.throws(
		() =>
			verifyZodLockfile(
				parseLockfile(fixture({ "example-package": {} })),
			),
		/No zod dependencies in lockfile importers/,
	);
});

test("zod advisory exception is limited to reviewed versions in the real lockfile", () => {
	const lockfile = readLockfile();
	verifyZodLockfile(lockfile);
	assertRejectsMalformed(verifyZodLockfile, lockfile);
	for (const key of ["zod@4.6.5", "zod@https://example.com/zod-4.6.7.tgz"]) {
		assert.throws(
			() =>
				verifyZodLockfile(
					validateLockfile(addPackage(mutableCopy(lockfile), key)),
				),
			new RegExp(
				`Unreviewed or vulnerable zod resolution: ${key.replace(/[.]/g, "\\.")}`,
			),
			key,
		);
	}
});

// ---------------------------------------------------------------------------
// Tracked first-party files and reviewed reference sites.
//
// A source guard here is an allowlist, not a list of bad spellings: it reads
// every tracked code file, finds each line that names the guarded package or
// API in any way, and requires the file to be a reviewed site whose matching
// lines equal the reviewed lines exactly (with counts). A new file, a new line
// or a changed line fails until it is reviewed, whatever its spelling.
// ---------------------------------------------------------------------------

function trackedFiles(cwd, noIndex) {
	if (noIndex) {
		const files = [];
		const walk = (directory) => {
			for (const entry of readdirSync(join(cwd, directory), {
				withFileTypes: true,
			})) {
				const path = directory
					? `${directory}/${entry.name}`
					: entry.name;
				if (entry.isDirectory()) {
					walk(path);
				} else {
					files.push(path);
				}
			}
		};
		walk("");
		return files;
	}
	const result = spawnSync("git", ["ls-files", "-z"], {
		cwd,
		encoding: "utf8",
		maxBuffer: 1 << 26,
	});
	assert.ok(
		result.error === undefined,
		`could not check: git ls-files did not run (${result.error?.message})`,
	);
	assert.ok(
		result.status === 0 && result.stderr === "",
		`could not check: git ls-files failed (${result.status}): ${result.stderr}`,
	);
	const files = result.stdout.split("\0").filter(Boolean);
	assert.ok(files.length > 0, "could not check: git ls-files listed nothing");
	return files;
}

/** The first line of a tracked file, read from its first 512 bytes. */
function trackedFirstLine(cwd, path) {
	let descriptor;
	try {
		descriptor = openSync(join(cwd, path), "r");
		const buffer = Buffer.alloc(512);
		const length = readSync(descriptor, buffer, 0, buffer.length, 0);
		return buffer.toString("latin1", 0, length).split(/\r?\n/, 1)[0];
	} catch (error) {
		return assert.fail(
			`could not check: ${path} is not readable (${error.message})`,
		);
	} finally {
		if (descriptor !== undefined) {
			closeSync(descriptor);
		}
	}
}

/**
 * A tracked file's text. A tracked path missing from the working tree is not
 * skipped: the guard has not read it, so it could not check.
 */
function readTracked(cwd, path) {
	try {
		return readFileSync(join(cwd, path), "utf8");
	} catch (error) {
		return assert.fail(
			`could not check: ${path} is not readable (${error.message})`,
		);
	}
}

function requirePlainObject(value, label) {
	assert.ok(
		value !== null && typeof value === "object" && !Array.isArray(value),
		`could not check: ${label} is not a mapping`,
	);
	return value;
}

function readJson(cwd, path) {
	const source = readTracked(cwd, path);
	try {
		return JSON.parse(source ?? "");
	} catch (error) {
		return assert.fail(
			`could not check: ${path} is not readable JSON (${error.message})`,
		);
	}
}

const codeFile = /\.(?:[cm]?[jt]sx?)$/;
// The dependency guards name the guarded packages to inspect their installed
// copies. They, and only they, are excluded from the source scans.
const guardFiles = new Set([
	"tooling/scripts/src/dependency-security.node-test.mjs",
	"tooling/scripts/src/dependency-upgrades.node-test.mjs",
	"tooling/scripts/src/pg-instrumentation-security.node-test.mjs",
]);

/** Trimmed lines matching `pattern`, with their counts. */
function matchingLines(source, pattern) {
	const lines = new Map();
	for (const line of source.split(/\r?\n/)) {
		if (pattern.test(line)) {
			const text = line.trim();
			lines.set(text, (lines.get(text) ?? 0) + 1);
		}
	}
	return lines;
}

// `reviewed` maps each line to its exact count, or "*" for a line that may
// repeat (only lines that cannot load anything, such as an env-var name).
function compareLines(path, found, reviewed, label) {
	const findings = [];
	for (const [text, count] of found) {
		if (!Object.hasOwn(reviewed, text)) {
			findings.push(`${path}: unreviewed ${label}: ${text}`);
		} else if (reviewed[text] !== "*" && reviewed[text] !== count) {
			findings.push(
				`${path}: ${label} appears ${count} times, reviewed ${reviewed[text]}: ${text}`,
			);
		}
	}
	for (const [text, count] of Object.entries(reviewed)) {
		if (count !== "*" && !found.has(text)) {
			findings.push(`${path}: reviewed ${label} is missing: ${text}`);
		}
	}
	return findings;
}

/**
 * Every tracked code file whose text matches `scan.pattern` must be one of
 * `scan.sites`; in each site, the matching lines, and the lines naming each
 * `bound` identifier, must equal the reviewed lines, and `verify` must pass.
 * A reviewed site that is no longer found also fails, so the allowlist cannot
 * go stale and an unread tree cannot pass.
 */
function reviewedSiteFindings(scan, { cwd = root, noIndex = false } = {}) {
	assert.equal(
		scan.pattern.global,
		false,
		"scan patterns must not be global",
	);
	const findings = [];
	const files = [];
	for (const path of trackedFiles(cwd, noIndex)) {
		if (!codeFile.test(path) || guardFiles.has(path)) {
			continue;
		}
		const source = readTracked(cwd, path);
		if (!scan.pattern.test(source)) {
			continue;
		}
		files.push(path);
		const lines = matchingLines(source, scan.pattern);
		if (!Object.hasOwn(scan.sites, path)) {
			findings.push(
				`${path}: unreviewed ${scan.label} reference: ${[...lines.keys()][0]}`,
			);
			continue;
		}
		const site = scan.sites[path];
		findings.push(
			...compareLines(path, lines, site.lines, `${scan.label} reference`),
		);
		for (const { pattern, lines: reviewed } of site.bound ?? []) {
			findings.push(
				...compareLines(
					path,
					matchingLines(source, pattern),
					reviewed,
					`use of ${pattern.source}`,
				),
			);
		}
		findings.push(...(site.verify?.(source, path) ?? []));
	}
	for (const path of Object.keys(scan.sites)) {
		if (!files.includes(path)) {
			findings.push(
				`${path}: reviewed ${scan.label} site not found; re-review it and update the allowlist`,
			);
		}
	}
	return { findings, files };
}

function writeTree(files) {
	const directory = mkdtempSync(join(tmpdir(), "dependency-guard-"));
	for (const [path, source] of Object.entries(files)) {
		const target = join(directory, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, source);
	}
	return directory;
}

function withTree(files, check) {
	const directory = writeTree(files);
	try {
		return check(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("tracked-file listing and reads fail closed", () => {
	withTree({ "a.ts": "export {};" }, (cwd) => {
		assert.throws(
			() => trackedFiles(join(cwd, "missing-directory"), false),
			/could not check: git ls-files did not run/,
		);
		const init = spawnSync("git", ["init", "-q", cwd], {
			encoding: "utf8",
		});
		assert.equal(init.status, 0, init.stderr);
		assert.throws(
			() => trackedFiles(cwd, false),
			/could not check: git ls-files listed nothing/,
		);
		rmSync(join(cwd, ".git"), { recursive: true, force: true });
		mkdirSync(join(cwd, "directory.ts"));
		assert.throws(
			() => readTracked(cwd, "directory.ts"),
			/could not check: directory\.ts is not readable/,
		);
		assert.throws(
			() => readTracked(cwd, "deleted.ts"),
			/could not check: deleted\.ts is not readable \(ENOENT/,
		);
	});
	// Outside any repository, git ls-files exits non-zero.
	const outside = mkdtempSync(join(tmpdir(), "dependency-guard-"));
	try {
		const probe = spawnSync("git", ["rev-parse", "--git-dir"], {
			cwd: outside,
			encoding: "utf8",
		});
		if (probe.status !== 0) {
			assert.throws(
				() => trackedFiles(outside, false),
				/could not check: git ls-files failed/,
			);
		}
	} finally {
		rmSync(outside, { recursive: true, force: true });
	}
});

test("reviewed-site scans fail on unreviewed files, lines and counts, and on missing sites", () => {
	const scan = {
		label: "example",
		pattern: /example-package/i,
		sites: {
			"reviewed.ts": {
				lines: {
					'import x from "example-package";': 1,
					"// EXAMPLE-PACKAGE note": "*",
				},
				bound: [
					{
						pattern: /\bx\b/,
						lines: {
							'import x from "example-package";': 1,
							"x.safe();": 1,
						},
					},
				],
				verify: (source) =>
					source.includes("x.safe();") ? [] : ["verify failed"],
			},
		},
	};
	const reviewed =
		'import x from "example-package";\n// EXAMPLE-PACKAGE note\n// EXAMPLE-PACKAGE note\nx.safe();\n';
	const scanTree = (files) =>
		withTree(files, (cwd) =>
			reviewedSiteFindings(scan, { cwd, noIndex: true }),
		);
	assert.deepEqual(scanTree({ "reviewed.ts": reviewed }).findings, []);
	for (const [label, files, expected] of [
		[
			"extra file",
			{ "other.mjs": 'require("example-package")' },
			/other\.mjs: unreviewed example reference/,
		],
		[
			"extra line",
			{
				"reviewed.ts": `${reviewed}const { danger: d } = require("example-package");\n`,
			},
			/unreviewed example reference: const \{ danger: d \}/,
		],
		[
			"repeated line",
			{
				"reviewed.ts": `${reviewed}import x from "example-package";\n`,
			},
			/appears 2 times, reviewed 1/,
		],
		[
			"unreviewed use of a bound identifier",
			{ "reviewed.ts": `${reviewed}x.danger();\n` },
			/unreviewed use of \\bx\\b: x\.danger\(\);/,
		],
		[
			"failed construct check",
			{ "reviewed.ts": reviewed.replace("x.safe();\n", "") },
			/verify failed/,
		],
		[
			"missing reviewed line",
			{
				"reviewed.ts": reviewed.replace(
					'import x from "example-package";\n',
					"",
				),
			},
			/reviewed example reference is missing: import x/,
		],
		["missing site", { "reviewed.ts": "export {};" }, /site not found/],
		[
			"guard path excluded only exactly",
			{
				"reviewed.ts": reviewed,
				"tooling/scripts/src/other-security.node-test.mjs":
					'require("example-package")',
			},
			/other-security\.node-test\.mjs: unreviewed/,
		],
	]) {
		const { findings } = scanTree({ "reviewed.ts": reviewed, ...files });
		assert.ok(
			findings.some((finding) => expected.test(finding)),
			`${label}: ${JSON.stringify(findings)}`,
		);
	}
	assert.deepEqual(
		scanTree({
			"reviewed.ts": reviewed,
			"tooling/scripts/src/dependency-security.node-test.mjs":
				'require("example-package")',
			"notes.md": "example-package",
		}).findings,
		[],
	);
});

// Identity 4.14.1 accepts fixed MSAL >=7.1.0. The separate agents-hosting
// parent still pins 5.1.5. The guard restricts below-floor copies to the
// reviewed parent and checks named first-party authorization-code entry points.
// SECURITY.md describes the scan's limits and the remaining third-party risk.
// Below the fixed floor, only reviewed 5.1.5 reached through the Teams
// channel's agents-hosting parent is accepted; any other consumer fails.
const msalNodeRule = {
	name: "@azure/msal-node",
	floor: "7.1.0",
	advisory: "GHSA-xcx6-jx8p-x3h5",
	reviewed: { "5.1.5": ["@microsoft/agents-hosting@1.8.1"] },
};

// The text scan requires named MSAL and Azure Identity references and
// authorization-code entry points in tracked code to be reviewed lines.
// Log Analytics and Anthropic federation use DefaultAzureCredential; two
// federation tests mock it. Bound-name lines are reviewed too. SECURITY.md
// explains the credential chain and the scan's limits.
const msalScan = {
	label: "MSAL or Azure Identity",
	pattern:
		/\bmsal|@azure\/identity|acquireTokenByCode|acquireTokenInteractive|getAuthCodeUrl|AuthorizationCodeCredential|InteractiveBrowserCredential|useIdentityPlugin/i,
	sites: {
		"packages/ai/__tests__/anthropic-federated-resolution.test.ts": {
			lines: { 'vi.mock("@azure/identity", () => ({': 1 },
			bound: [
				{
					pattern: /\bDefaultAzureCredential\b/,
					lines: { "DefaultAzureCredential: class {": 1 },
				},
			],
		},
		"packages/ai/__tests__/anthropic-federation.test.ts": {
			lines: { 'vi.mock("@azure/identity", () => ({': 1 },
			bound: [
				{
					pattern: /\bDefaultAzureCredential\b/,
					lines: { "DefaultAzureCredential: class {": 1 },
				},
			],
		},
		"packages/ai/lib/anthropic-federation.ts": {
			lines: {
				'import type { DefaultAzureCredential } from "@azure/identity";': 1,
				'const { DefaultAzureCredential } = await import("@azure/identity");': 1,
			},
			bound: [
				{
					pattern: /\bDefaultAzureCredential\b/,
					lines: {
						'import type { DefaultAzureCredential } from "@azure/identity";': 1,
						"let entra: DefaultAzureCredential | undefined;": 1,
						'const { DefaultAzureCredential } = await import("@azure/identity");': 1,
						"entra ??= new DefaultAzureCredential();": 1,
					},
				},
				{
					pattern: /\bentra\b/,
					lines: {
						"let entra: DefaultAzureCredential | undefined;": 1,
						"if (!entra) {": 1,
						"entra ??= new DefaultAzureCredential();": 1,
						"const assertion = await entra.getToken(": 1,
					},
				},
			],
		},
		"packages/temporal/src/activities/backlog-context/azure-monitor-log-source.ts":
			{
				lines: {
					'const { DefaultAzureCredential } = await import("@azure/identity");': 1,
				},
				bound: [
					{
						pattern: /\bDefaultAzureCredential\b/,
						lines: {
							"* Auth uses `DefaultAzureCredential`, so the worker's managed identity is used": 1,
							'const { DefaultAzureCredential } = await import("@azure/identity");': 1,
							"const credential = new DefaultAzureCredential(": 1,
						},
					},
				],
			},
	},
};

test("MSAL and Azure Identity scan fails on any unreviewed first-party site", () => {
	const reviewedPath =
		"packages/temporal/src/activities/backlog-context/azure-monitor-log-source.ts";
	const reviewed =
		'/**\n * Auth uses `DefaultAzureCredential`, so the worker\'s managed identity is used\n */\nconst { DefaultAzureCredential } = await import("@azure/identity");\nconst credential = new DefaultAzureCredential(\n\t{},\n);\n';
	const mock =
		'vi.mock("@azure/identity", () => ({\nDefaultAzureCredential: class {\n';
	const federation =
		'import type { DefaultAzureCredential } from "@azure/identity";\nlet entra: DefaultAzureCredential | undefined;\nif (!entra) {\nconst { DefaultAzureCredential } = await import("@azure/identity");\nentra ??= new DefaultAzureCredential();\n}\nconst assertion = await entra.getToken(\n';
	const scanTree = (files) =>
		withTree(
			{
				"packages/ai/__tests__/anthropic-federated-resolution.test.ts":
					mock,
				"packages/ai/__tests__/anthropic-federation.test.ts": mock,
				"packages/ai/lib/anthropic-federation.ts": federation,
				[reviewedPath]: reviewed,
				...files,
			},
			(cwd) => reviewedSiteFindings(msalScan, { cwd, noIndex: true }),
		);
	assert.deepEqual(scanTree({}).findings, []);
	for (const [label, files] of [
		[
			"msal import",
			{
				"apps/web/session.ts":
					'import { ConfidentialClientApplication } from "@azure/msal-node";',
			},
		],
		[
			"auth-code call through a wrapper",
			{
				"packages/api/auth.ts":
					'client.acquireTokenByCode({ code: "x" });',
			},
		],
		[
			"plugin registration in a test",
			{
				"apps/web/session.test.ts":
					"useIdentityPlugin(syntheticPlugin);",
			},
		],
		[
			"additional federation credential call",
			{
				"packages/ai/lib/anthropic-federation.ts": `${federation}entra.getToken("other");\n`,
			},
		],
		[
			"additional mock credential",
			{
				"packages/ai/__tests__/anthropic-federation.test.ts": `${mock}DefaultAzureCredential: class {},\n`,
			},
		],
		[
			"additional resolution mock credential",
			{
				"packages/ai/__tests__/anthropic-federated-resolution.test.ts": `${mock}DefaultAzureCredential: class {},\n`,
			},
		],
		[
			"additional federation credential construction",
			{
				"packages/ai/lib/anthropic-federation.ts": `${federation}new DefaultAzureCredential();\n`,
			},
		],
		[
			"second identity import in the reviewed file",
			{
				[reviewedPath]: `${reviewed}const { InteractiveBrowserCredential: I } = await import("@azure/identity");\n`,
			},
		],
		[
			"multi-line destructure in the reviewed file",
			{
				[reviewedPath]: reviewed.replace(
					'const { DefaultAzureCredential } = await import("@azure/identity");',
					'const {\n\tDefaultAzureCredential,\n\tuseIdentityPlugin,\n} = await import("@azure/identity");',
				),
			},
		],
	]) {
		assert.notDeepEqual(scanTree(files).findings, [], label);
	}
});

test("msal-node exception permits only reviewed 5.1.5 under agents-hosting", () => {
	belowFloorRuleChecks(msalNodeRule, "7.1.2", "5.6.0");
	for (const version of ["6.0.0", "7.0.2", "7.1.0-beta.1", "7.2.0-beta.1"]) {
		assert.throws(
			() =>
				verifyReviewedBelowFloor(
					belowFloorSnippet(
						msalNodeRule.name,
						version,
						"@microsoft/agents-hosting@1.8.1",
					),
					msalNodeRule,
				),
			/Unreviewed @azure\/msal-node resolution/,
			version,
		);
	}
	assert.throws(
		() =>
			belowFloorSnippet(
				msalNodeRule.name,
				"invalid",
				"@microsoft/agents-hosting@1.8.1",
			),
		/could not check/,
	);
});

test("msal-node 5.1.5 reached through a second consumer fails", () => {
	const mutated = mutableCopy(readLockfile());
	const identity = Object.keys(mutated.snapshots).find((key) =>
		key.startsWith("@azure/identity@4.14.1"),
	);
	assert.ok(identity, "Missing @azure/identity@4.14.1 snapshot");
	mutated.snapshots[identity].dependencies["@azure/msal-node"] = "5.1.5";
	assert.throws(
		() => verifyReviewedBelowFloor(validateLockfile(mutated), msalNodeRule),
		/Unreviewed @azure\/msal-node@5\.1\.5 consumer: @azure\/identity@4\.14\.1/,
	);
});

test("no first-party code reaches the msal-node authorization-code flow", () => {
	const { findings, files } = reviewedSiteFindings(msalScan);
	assert.deepEqual(findings, []);
	assert.deepEqual(files, Object.keys(msalScan.sites));
});

// An ID-wide OSV ignore also hides any new vulnerable copy, so each exception
// below allows a version under the fixed floor (or any prerelease) only when
// it is a reviewed version referenced by its reviewed parent. Stable fixed
// copies are unrestricted.
function verifyReviewedBelowFloor(lockfile, rule) {
	requireLockfile(lockfile);
	const below = (version) => !isStableAtLeast(version, rule.floor);
	const reviewed = (version) => Object.hasOwn(rule.reviewed, version);
	for (const section of ["packages", "snapshots"]) {
		const entries = entriesNamed(lockfile, section, rule.name);
		assert.ok(entries.length > 0, `No ${rule.name} entries in ${section}`);
		for (const { key, version } of entries) {
			assert.ok(
				!below(version) || reviewed(version),
				`Unreviewed ${rule.name} resolution: ${key} (${section}); ${rule.advisory} is dismissed only for reviewed versions`,
			);
		}
	}
	for (const reference of referencesTo(lockfile, rule.name)) {
		const version = referencedVersion(reference, rule.name);
		if (!below(version)) {
			continue;
		}
		const parent =
			reference.section === "importers"
				? reference.owner
				: `${reference.ownerName}@${reference.ownerVersion}`;
		assert.ok(
			reviewed(version) && rule.reviewed[version].includes(parent),
			`Unreviewed ${rule.name}@${version} consumer: ${reference.owner}`,
		);
	}
}

function belowFloorSnippet(name, version, parent) {
	return parseLockfile(
		syntheticLockfile({
			packages: { [`${name}@${version}`]: {}, [parent]: {} },
			snapshots: {
				[`${name}@${version}`]: {},
				[parent]: { dependencies: { [name]: version } },
			},
		}),
	);
}

function belowFloorRuleChecks(rule, fixedVersion, unreviewedVersion) {
	const [reviewedVersion, [reviewedParent]] = Object.entries(
		rule.reviewed,
	)[0];
	assert.doesNotThrow(() =>
		verifyReviewedBelowFloor(
			belowFloorSnippet(rule.name, reviewedVersion, reviewedParent),
			rule,
		),
	);
	assert.doesNotThrow(() =>
		verifyReviewedBelowFloor(
			belowFloorSnippet(rule.name, fixedVersion, "any-parent@1.0.0"),
			rule,
		),
	);
	assert.throws(
		() =>
			verifyReviewedBelowFloor(
				belowFloorSnippet(rule.name, unreviewedVersion, reviewedParent),
				rule,
			),
		/Unreviewed .* resolution/,
	);
	assert.throws(
		() =>
			verifyReviewedBelowFloor(
				belowFloorSnippet(
					rule.name,
					reviewedVersion,
					"other-parent@1.0.0",
				),
				rule,
			),
		/consumer: other-parent@1\.0\.0/,
	);
	assert.throws(
		() =>
			verifyReviewedBelowFloor(
				parseLockfile(
					syntheticLockfile({
						packages: { "other@1.0.0": {} },
						snapshots: { "other@1.0.0": {} },
					}),
				),
				rule,
			),
		/No .* entries in packages/,
	);
	for (const text of [
		"packages: [",
		"",
		"importers: {}\npackages: {}\nsnapshots: {}",
		"packages: {}",
		"packages: null\nsnapshots: null",
	]) {
		assert.throws(
			() => verifyReviewedBelowFloor(parseLockfile(text), rule),
			/could not check/,
			text,
		);
	}
	const lockfile = readLockfile();
	verifyReviewedBelowFloor(lockfile, rule);
	assertRejectsMalformed(
		(bad) => verifyReviewedBelowFloor(bad, rule),
		lockfile,
	);
	// A real snapshot that picks up an unreviewed vulnerable copy must fail.
	const mutated = mutableCopy(lockfile);
	const owner = Object.keys(mutated.snapshots).find(
		(key) => !key.startsWith(`${rule.name}@`),
	);
	// The reviewed copy's own snapshot key, peer suffix included.
	const reviewedKey = Object.keys(mutated.snapshots).find(
		(key) =>
			key === `${rule.name}@${reviewedVersion}` ||
			key.startsWith(`${rule.name}@${reviewedVersion}(`),
	);
	assert.ok(reviewedKey, `Missing ${rule.name}@${reviewedVersion} snapshot`);
	mutated.snapshots[owner] = {
		...mutated.snapshots[owner],
		dependencies: {
			...(mutated.snapshots[owner].dependencies ?? {}),
			[rule.name]: reviewedKey.slice(rule.name.length + 1),
		},
	};
	assert.throws(
		() => verifyReviewedBelowFloor(validateLockfile(mutated), rule),
		/consumer/,
	);
}

// GHSA-67mh-4wv8-2f99: esbuild <0.25.0 lets any website read responses from
// its development server (`serve`). No parent release moves these copies:
// drizzle-kit 0.31.11 still uses @esbuild-kit/esm-loader, and partykit
// 0.0.115 is the latest release and pins esbuild 0.21.5.
const esbuildRule = {
	name: "esbuild",
	floor: "0.25.0",
	advisory: "GHSA-67mh-4wv8-2f99",
	reviewed: {
		"0.18.20": ["@esbuild-kit/core-utils@3.3.2"],
		"0.21.5": ["partykit@0.0.115"],
	},
};

test("esbuild exception permits only reviewed copies under their reviewed parents", () => {
	belowFloorRuleChecks(esbuildRule, "0.25.12", "0.24.2");
});

// @esbuild-kit/core-utils loads esbuild once, into one binding, and uses only
// its version and transform APIs. Every use of that binding must be one of
// the reviewed forms, so serve, context, a destructure or an alias fails.
function verifyTransformOnlyEsbuild(source) {
	const loads = source.match(
		/(?:require|import)\s*\(\s*["']esbuild|from\s*["']esbuild/g,
	);
	assert.equal(loads?.length, 1, "esbuild must be loaded exactly once");
	const binding = /([A-Za-z_$][\w$]*)\s*=\s*require\("esbuild"\)/.exec(
		source,
	)?.[1];
	assert.ok(binding, "esbuild must be bound by a single require");
	const uses = [
		...source.matchAll(
			new RegExp(
				`(?<![\\w$.])${binding.replace(/\$/g, "\\$")}(?![\\w$])[^;,)]{0,20}`,
				"g",
			),
		),
	].map(([use]) => use);
	assert.ok(uses.length > 1, "esbuild binding uses not read");
	for (const use of uses) {
		assert.ok(
			[
				`${binding}=require("esbuild"`,
				`${binding}.version`,
				`${binding}.transformSync(`,
				`${binding}.transform(`,
			].some((reviewed) => use.replace(/\s+/g, "").startsWith(reviewed)),
			`Unreviewed esbuild use in @esbuild-kit/core-utils: ${use}`,
		);
	}
}

// partykit starts esbuild's server only from useAssetServer: its one `.serve(`
// call sits in an effect that returns early without an assets path, which is
// `config.serve` from partykit.json, package.json `partykit` or `--serve`.
function verifyPartykitServeSite(source) {
	const serves = [...source.matchAll(/\.serve\(/g)];
	assert.equal(serves.length, 1, "partykit must have one .serve( call");
	const serve = serves[0].index;
	// The nearest top-level function declaration before the call.
	const body = source.slice(source.lastIndexOf("\nfunction ", serve), serve);
	assert.ok(
		body.startsWith(
			"\nfunction useAssetServer(options, defines, moreOptions) {",
		),
		"serve call is not inside useAssetServer",
	);
	assert.ok(
		body.includes(
			'const assetsPath = !options ? void 0 : typeof options === "string" ? options : options.path;',
		),
		"useAssetServer no longer derives assetsPath from its options",
	);
	assert.ok(
		/useEffect\)\(\(\) => \{\s*if \(!assetsPath\) return;\s*let ctx;\s*async function startServer\(\) \{\s*ctx = await esbuild\.context\(esbuildAssetOptions\);\s*await ctx\.watch\(\);\s*await ctx$/.test(
			body,
		),
		"serve call is not guarded by the assets path",
	);
	const calls = [...source.matchAll(/useAssetServer\(/g)];
	assert.equal(
		calls.length,
		2,
		"useAssetServer must be defined and called once",
	);
	assert.ok(
		source.includes("useAssetServer(config.serve,"),
		"useAssetServer is not called with config.serve",
	);
}

test("reviewed esbuild consumers can only start the development server from a serve config", () => {
	for (const parent of installedConsumers(
		"@esbuild-kit/core-utils",
		"3.3.2",
	)) {
		verifyTransformOnlyEsbuild(
			readFileSync(parent.require.resolve("./dist/index.js"), "utf8"),
		);
	}
	for (const parent of installedConsumers("partykit", "0.0.115")) {
		verifyPartykitServeSite(
			readFileSync(parent.require.resolve("./dist/bin.mjs"), "utf8"),
		);
	}
});

test("installed esbuild consumer checks fail on serve, context, destructured and aliased uses", () => {
	const reviewed =
		'var t=require("url"),ne=require("esbuild");ne.transformSync(a,b);ne.transform(c,d);console.log(ne.version);';
	assert.doesNotThrow(() => verifyTransformOnlyEsbuild(reviewed));
	for (const source of [
		'var ne=require("esbuild");',
		`${reviewed}ne.serve({});`,
		`${reviewed}ne.context({});`,
		`${reviewed}const{serve:s}=ne;`,
		`${reviewed}const x=ne;`,
		`${reviewed}run(ne);`,
		`${reviewed}import("esbuild");`,
	]) {
		assert.throws(() => verifyTransformOnlyEsbuild(source), source);
	}
	assert.throws(
		() =>
			verifyTransformOnlyEsbuild(
				reviewed.replace(
					'ne=require("esbuild")',
					'ne=require("esbuild/lib/main")',
				),
			),
		/esbuild must be bound by a single require/,
	);
	const partykit = readFileSync(
		installedConsumers("partykit", "0.0.115")[0].require.resolve(
			"./dist/bin.mjs",
		),
		"utf8",
	);
	for (const source of [
		partykit.replace(
			"function useAssetServer(options, defines, moreOptions) {",
			"function useAssetServer(options, defines, moreOptions) {}\nfunction injected() {",
		),
		partykit.replace(
			"const assetsPath = !options ? void 0 :",
			'const assetsPath = "public" || !options ? void 0 :',
		),
		`${partykit}\nserver.serve({});`,
		partykit.replace(
			"    if (!assetsPath) return;\n    let ctx;",
			"    let ctx;",
		),
		partykit.replace(
			"useAssetServer(config.serve,",
			"useAssetServer(config.assets,",
		),
		`${partykit}\nuseAssetServer(other, {});`,
	]) {
		assert.notEqual(source, partykit);
		assert.throws(() => verifyPartykitServeSite(source));
	}
});

// partykit reads `serve` from the file named by -c/--config, else the first
// partykit.json, partykit.json5 or partykit.jsonc found upward from its working
// directory, else the `partykit` key of the nearest package.json upward
// (bin.mjs getConfigPath and getConfig); `--serve` on the command line also
// starts the server. So every tracked line or package script that names
// partykit as a command must equal a reviewed entry exactly, and the configs
// it can read must not set `serve`.
const partykitMention = /(?<![A-Za-z0-9_.-])partykit(?![A-Za-z0-9_.-])/i;
const partykitConfigName = /(?:^|\/)partykit[^/]*\.json[c5]?$/;
const partykitConfigFiles = [
	"partykit.json",
	"partykit.json5",
	"partykit.jsonc",
];

/** The tracked files that can launch a command, by kind. */
// A shell or Node shebang on an extensionless file (bin/dev, .githooks/*).
const launcherShebang =
	/^#![ \t]*(?:\/[^\s]*\/)?(?:env[ \t]+(?:-[^\s]+[ \t]+)*)?(?:sh|bash|zsh|node|npx)(?:[ \t]|$)/;

function launcherKind(path, cwd) {
	const name = path.slice(path.lastIndexOf("/") + 1);
	if (name === "package.json") {
		return "package";
	}
	if (
		/\.(?:sh|bash|zsh|ps1|cmd|bat)$/.test(name) ||
		/^(?:Dockerfile.*|.*\.[Dd]ockerfile|Makefile|GNUmakefile|makefile|[Jj]ustfile|Procfile)$/.test(
			name,
		) ||
		/^(?:docker-)?compose[^/]*\.ya?ml$/.test(name) ||
		/^\.github\/.*\.ya?ml$/.test(path) ||
		/^\.vscode\/[^/]+\.json$/.test(path) ||
		name === "vercel.json" ||
		/^aspire\/.*\.cs$/.test(path)
	) {
		return "lines";
	}
	// Any other file, with no extension or one the names above do not
	// recognize, is a launcher when its first line is a shell or Node shebang.
	if (launcherShebang.test(trackedFirstLine(cwd, path))) {
		return "lines";
	}
	return null;
}

// Each entry is one reviewed mention, by exact script value or trimmed line.
// `cwd` marks an entry that starts partykit (directly, or through
// party/start-dev.sh) and names the working directory it runs in; every
// package.json and partykit config from there up to the repository root is
// checked for `serve`. The other entries are comments, names and messages
// that cannot start the CLI.
const reviewedPartykitMentions = [
	// `pnpm dev` / `pnpm deploy` in the party workspace (party/package.json:7-8).
	{
		path: "party/package.json",
		script: "dev",
		text: "partykit dev",
		cwd: "party",
	},
	{
		path: "party/package.json",
		script: "deploy",
		text: "partykit deploy",
		cwd: "party",
	},
	// The Aspire and docker-compose wrapper; it passes only --port (party/start-dev.sh:7).
	{
		path: "party/start-dev.sh",
		text: 'exec npx partykit dev --port "$PORT"',
		cwd: "party",
	},
	{
		path: "party/start-dev.sh",
		text: "# Start PartyKit dev server with port from environment variable",
	},
	{
		path: "party/start-dev.sh",
		text: 'echo "Starting PartyKit dev server on port $PORT..."',
	},
	// Aspire runs `sh ./start-dev.sh` in party/ (aspire/Fabric.AppHost/Program.cs:1940).
	{
		path: "aspire/Fabric.AppHost/Program.cs",
		text: 'var partykit = builder.AddExecutable("partykit", "sh", "../../party", "./start-dev.sh")',
		cwd: "party",
	},
	{
		path: "aspire/Fabric.AppHost/Program.cs",
		text: "// LOCAL-ONLY SERVICES (PartyKit, Web App, Sandbox Worker)",
	},
	{
		path: "aspire/Fabric.AppHost/Program.cs",
		text: "// These are deployed separately (Cloudflare for PartyKit/Sandbox, Vercel for Web)",
	},
	{
		path: "aspire/Fabric.AppHost/Program.cs",
		text: "// PartyKit (deployed to Cloudflare in production)",
	},
	{
		path: "aspire/Fabric.AppHost/Program.cs",
		text: "partykit = partykit.WithEnvironment(key, value);",
	},
	// docker-compose's partykit service runs ./start-dev.sh in /app/party (docker-compose.yml:461-479).
	{ path: "docker-compose.yml", text: "partykit:", cwd: "party" },
	{
		path: "docker-compose.yml",
		text: "# PARTYKIT - REAL-TIME COLLABORATION",
	},
	{
		path: "docker-compose.yml",
		text: "# PartyKit server for real-time collaboration features (document editing, presence, etc.)",
	},
	{ path: "docker-compose.yml", text: "echo 'Starting PartyKit server...';" },
	{ path: "docker-compose.yml", text: "partykit_node_modules:  # partykit" },
	// Process matching and messages in the Aspire helper (aspire.sh:111, 133, 139).
	{
		path: "aspire.sh",
		text: '"fabric.*partykit"          # Fabric\'s PartyKit server',
	},
	{
		path: "aspire.sh",
		text: "# Port 3001: Fabric web app, Port 1999: PartyKit",
	},
	{
		path: "aspire.sh",
		text: 'if [[ "$proc_cmd" == *"fabric"* ]] || [[ "$proc_cmd" == *"apps/web"* ]] || [[ "$proc_cmd" == *"partykit"* ]]; then',
	},
	// Key Vault secret names (deployment/azure/configure-keyvault-secrets.sh:173, 176).
	{
		path: "deployment/azure/configure-keyvault-secrets.sh",
		text: 'echo "PartyKit (Real-time Collaboration) Secrets"',
	},
	{
		path: "deployment/azure/configure-keyvault-secrets.sh",
		text: 'set_secret "partykit-host" "NEXT_PUBLIC_PARTYKIT_HOST" "PartyKit host URL"',
	},
	// The Workers container runs wrangler, not partykit (party-cf/Dockerfile:1, 15).
	{
		path: "party-cf/Dockerfile",
		text: "# Self-hosted PartyKit (Fabric real-time collaboration) — Cloudflare-free container.",
	},
	{
		path: "party-cf/Dockerfile",
		text: "# `party/` service which runs `partykit dev` in a container.",
	},
];

const mentionKey = ({ path, script, text }) =>
	JSON.stringify([path, script ?? null, text]);

function partykitConfigServe(cwd, path, findings) {
	const config = requirePlainObject(readJson(cwd, path), path);
	if (Object.hasOwn(config, "serve")) {
		findings.push(`${path}: configures serve`);
	}
}

function packagePartykitServe(path, manifest, findings) {
	requirePlainObject(manifest, path);
	if (Object.hasOwn(manifest, "partykit")) {
		const config = requirePlainObject(
			manifest.partykit,
			`${path} partykit`,
		);
		if (Object.hasOwn(config, "serve")) {
			findings.push(`${path}: configures partykit serve`);
		}
	}
}

function partykitServeFindings(
	cwd = root,
	noIndex = false,
	reviewed = reviewedPartykitMentions,
) {
	const findings = [];
	const files = trackedFiles(cwd, noIndex);
	const mentions = [];
	for (const path of files) {
		const kind = launcherKind(path, cwd);
		if (kind === null) {
			continue;
		}
		if (kind === "package") {
			const manifest = readJson(cwd, path);
			packagePartykitServe(path, manifest, findings);
			if (Object.hasOwn(manifest, "scripts")) {
				for (const [script, text] of Object.entries(
					requirePlainObject(manifest.scripts, `${path} scripts`),
				)) {
					assert.equal(
						typeof text,
						"string",
						`could not check: ${path} script ${script} is not a string`,
					);
					if (partykitMention.test(text)) {
						mentions.push({ path, script, text });
					}
				}
			}
			continue;
		}
		const source = readTracked(cwd, path);
		const lines = source.split(/\r?\n/);
		lines.forEach((line, index) => {
			if (partykitMention.test(line)) {
				mentions.push({
					path,
					text: line.trim(),
					previous: index > 0 ? lines[index - 1] : "",
				});
			}
		});
	}
	const remaining = new Map();
	for (const entry of reviewed) {
		const key = mentionKey(entry);
		remaining.set(key, [...(remaining.get(key) ?? []), entry]);
	}
	const launchDirectories = new Set();
	for (const mention of mentions) {
		const entry = remaining.get(mentionKey(mention))?.shift();
		if (!entry) {
			findings.push(
				`${mention.path}: unreviewed partykit mention${mention.script ? ` in script ${mention.script}` : ""}: ${mention.text}`,
			);
			continue;
		}
		if (entry.cwd === undefined) {
			continue;
		}
		launchDirectories.add(entry.cwd);
		// A continuation (or an `xargs \` before it) could add flags.
		if (/[\\`^]\s*$/.test(mention.previous ?? "")) {
			findings.push(
				`${mention.path}: reviewed partykit launcher follows a continued line: ${mention.text}`,
			);
		}
	}
	for (const entries of remaining.values()) {
		for (const entry of entries) {
			findings.push(
				`${entry.path}: reviewed partykit mention not found; re-review it and update the allowlist: ${entry.text}`,
			);
		}
	}
	const configs = files.filter((path) => partykitConfigName.test(path));
	for (const path of configs) {
		partykitConfigServe(cwd, path, findings);
	}
	// partykit searches upward from its working directory, so the files it can
	// read there count whether or not they are tracked.
	const checked = new Set(configs);
	for (const launch of launchDirectories) {
		for (
			let directory = launch;
			;
			directory = directory.includes("/")
				? directory.slice(0, directory.lastIndexOf("/"))
				: ""
		) {
			const prefix = directory ? `${directory}/` : "";
			for (const name of partykitConfigFiles) {
				const path = `${prefix}${name}`;
				if (!checked.has(path) && existsSync(join(cwd, path))) {
					checked.add(path);
					partykitConfigServe(cwd, path, findings);
				}
			}
			const manifest = `${prefix}package.json`;
			if (!checked.has(manifest) && existsSync(join(cwd, manifest))) {
				checked.add(manifest);
				if (!files.includes(manifest)) {
					packagePartykitServe(
						manifest,
						readJson(cwd, manifest),
						findings,
					);
				}
			}
			if (directory === "") {
				break;
			}
		}
	}
	return { findings: [...new Set(findings)], configs, mentions, checked };
}

test("tracked PartyKit configs and launchers cannot start the esbuild development server", () => {
	const { findings, configs, mentions, checked } = partykitServeFindings();
	assert.deepEqual(findings, []);
	assert.ok(configs.includes("party/partykit.json"));
	assert.ok(
		mentions.some(
			(mention) =>
				mention.path === "party/package.json" &&
				mention.script === "dev",
		),
	);
	assert.ok(checked.has("party/package.json") && checked.has("package.json"));
});

test("PartyKit serve check reads untracked configs and package.json files above a launcher", () => {
	const reviewed = [
		{
			path: "party/package.json",
			script: "dev",
			text: "partykit dev",
			cwd: "party",
		},
	];
	for (const [label, untracked, expected] of [
		[
			"parent package.json",
			{ "package.json": '{ "partykit": { "serve": "public" } }' },
			/^package\.json: configures partykit serve/,
		],
		[
			"launcher partykit.jsonc",
			{ "party/partykit.jsonc": '{ "serve": "public" }' },
			/^party\/partykit\.jsonc: configures serve/,
		],
		[
			"parent partykit.json",
			{ "partykit.json": '{ "serve": "public" }' },
			/^partykit\.json: configures serve/,
		],
	]) {
		withTree(
			{
				"party/package.json":
					'{ "scripts": { "dev": "partykit dev" } }',
			},
			(cwd) => {
				for (const args of [
					["init", "-q"],
					["add", "party/package.json"],
				]) {
					const result = spawnSync("git", args, {
						cwd,
						encoding: "utf8",
					});
					assert.equal(result.status, 0, result.stderr);
				}
				assert.deepEqual(
					partykitServeFindings(cwd, false, reviewed).findings,
					[],
				);
				for (const [path, source] of Object.entries(untracked)) {
					writeFileSync(join(cwd, path), source);
				}
				const { findings } = partykitServeFindings(
					cwd,
					false,
					reviewed,
				);
				assert.ok(
					findings.some((finding) => expected.test(finding)),
					`${label}: ${JSON.stringify(findings)}`,
				);
			},
		);
	}
});

test("a tracked file missing from the working tree could not be checked", () => {
	const launcher = {
		path: "party/package.json",
		script: "dev",
		text: "partykit dev",
		cwd: "party",
	};
	for (const [label, deleted, scan] of [
		[
			"PartyKit package.json",
			"party/package.json",
			(cwd) => partykitServeFindings(cwd, false, [launcher]),
		],
		[
			"PartyKit extensionless file",
			"bin/collab",
			(cwd) => partykitServeFindings(cwd, false, [launcher]),
		],
		[
			"Application Insights source",
			"src/telemetry.ts",
			(cwd) => reviewedSiteFindings(azureMonitorScan, { cwd }),
		],
	]) {
		withTree(
			{
				"party/package.json":
					'{ "scripts": { "dev": "partykit dev" } }',
				"bin/collab": "#!/bin/sh\n",
				"src/telemetry.ts": "export {};\n",
			},
			(cwd) => {
				for (const args of [
					["init", "-q"],
					["add", "."],
				]) {
					const result = spawnSync("git", args, {
						cwd,
						encoding: "utf8",
					});
					assert.equal(result.status, 0, result.stderr);
				}
				scan(cwd);
				rmSync(join(cwd, deleted));
				assert.throws(
					() => scan(cwd),
					new RegExp(
						`could not check: ${deleted.replace(/[.]/g, "\\.")} is not readable \\(ENOENT`,
					),
					label,
				);
			},
		);
	}
});

test("PartyKit serve check fails on unreviewed launchers and on serve in any config it reads", () => {
	const reviewed = [
		{
			path: "party/package.json",
			script: "dev",
			text: "partykit dev",
			cwd: "party",
		},
		{
			path: "party/start.sh",
			text: 'exec npx partykit dev --port "$PORT"',
			cwd: "party",
		},
	];
	const base = {
		"party/partykit.json": '{ "name": "example" }',
		"party/package.json": '{ "scripts": { "dev": "partykit dev" } }',
		"party/start.sh": '#!/bin/sh\nexec npx partykit dev --port "$PORT"\n',
		"package.json": '{ "name": "example-root" }',
	};
	const run = (files) =>
		withTree({ ...base, ...files }, (cwd) =>
			partykitServeFindings(cwd, true, reviewed),
		);
	assert.deepEqual(run({}).findings, []);
	const cases = [
		[
			"config serve",
			{ "party/partykit.json": '{ "serve": "public" }' },
			/partykit\.json: configures serve/,
		],
		[
			"json5 serve",
			{ "party/partykit.json5": '{ "serve": "public" }' },
			/partykit\.json5: configures serve/,
		],
		[
			"package.json serve",
			{
				"party/package.json":
					'{ "scripts": { "dev": "partykit dev" }, "partykit": { "serve": "public" } }',
			},
			/party\/package\.json: configures partykit serve/,
		],
		[
			"parent package.json serve",
			{ "package.json": '{ "partykit": { "serve": "public" } }' },
			/^package\.json: configures partykit serve/,
		],
		[
			"quoted --serve",
			{
				"party/start.sh":
					'exec npx partykit dev --port "$PORT" "--serve" public\n',
			},
			/unreviewed partykit mention: exec npx partykit dev --port "\$PORT" "--serve" public/,
		],
		[
			"changed script",
			{
				"party/package.json":
					'{ "scripts": { "dev": "partykit dev --serve=public" } }',
			},
			/unreviewed partykit mention in script dev/,
		],
		[
			"second script",
			{
				"tools/package.json":
					'{ "scripts": { "assets": "npx partykit dev" } }',
			},
			/tools\/package\.json: unreviewed partykit mention in script assets/,
		],
		[
			"Dockerfile",
			{ "party/Dockerfile": "RUN npx partykit dev\n" },
			/party\/Dockerfile: unreviewed/,
		],
		...[
			"#!/bin/sh",
			"#!/usr/bin/env bash",
			"#! /bin/zsh -e",
			"#!/usr/bin/env -S node --no-warnings",
			"#!/usr/bin/env npx",
		].map((shebang) => [
			`extensionless ${shebang}`,
			{ "bin/collab": `${shebang}\nexec npx partykit dev\n` },
			/^bin\/collab: unreviewed partykit mention: exec npx partykit dev$/,
		]),
		...["bin/collab.command", "bin/collab.mjs"].map((path) => [
			`unrecognized extension ${path}`,
			{ [path]: "#!/usr/bin/env node\nexec npx partykit dev\n" },
			new RegExp(
				`^${path.replace(/[.]/g, "\\.")}: unreviewed partykit mention`,
			),
		]),
		[
			"workflow",
			{
				".github/workflows/collab.yml":
					"run: npx PartyKit@0.0.115 dev\n",
			},
			/collab\.yml: unreviewed/,
		],
		[
			"Aspire host",
			{ "aspire/Host.cs": 'AddExecutable("p", "partykit", ".")\n' },
			/Host\.cs: unreviewed/,
		],
		[
			"removed launcher",
			{ "party/start.sh": "#!/bin/sh\n" },
			/reviewed partykit mention not found/,
		],
		[
			"continued line",
			{
				"party/start.sh":
					'#!/bin/sh\necho --serve public | xargs \\\nexec npx partykit dev --port "$PORT"\n',
			},
			/follows a continued line/,
		],
	];
	for (const [label, files, expected] of cases) {
		const { findings } = run(files);
		assert.ok(
			findings.some((finding) => expected.test(finding)),
			`${label}: ${JSON.stringify(findings)}`,
		);
	}
	// Mentions that are not a command word stay out of the scan.
	assert.deepEqual(
		run({
			"party/start.sh":
				'#!/bin/sh\nPORT="$PARTYKIT_PORT"\nexec npx partykit dev --port "$PORT"\n',
			"party/.gitignore": ".partykit\n",
			// Extensionless files without a shell or Node shebang, and a
			// shebang file with an extension the scan does not read.
			"bin/notes": "exec npx partykit dev\n",
			"bin/collab-py": "#!/usr/bin/env python3\nexec npx partykit dev\n",
			"bin/collab.txt": "# exec npx partykit dev\n#!/bin/sh\n",
		}).findings,
		[],
	);
	for (const [label, files] of [
		["unparseable jsonc", { "party/partykit.jsonc": "{ // comment\n }" }],
		["array config", { "party/partykit.json": "[]" }],
		[
			"scalar package partykit",
			{
				"party/package.json":
					'{ "scripts": { "dev": "partykit dev" }, "partykit": "x" }',
			},
		],
		[
			"scalar scripts",
			{ "party/package.json": '{ "scripts": "partykit dev" }' },
		],
		[
			"numeric script",
			{ "party/package.json": '{ "scripts": { "dev": 1 } }' },
		],
		["unparseable package.json", { "party/package.json": "{" }],
	]) {
		assert.throws(() => run(files), /could not check/, label);
	}
});

// GHSA-3v2p-hm54-8qcq: instrumentation-http <0.222.0 copies raw query strings
// into server spans. auto-instrumentations-node resolves the fixed line; the
// Azure Monitor distro 1.20.1 (and its latest, 1.21.0) still declares
// ^0.221.0. Its instrumentations are registered only by useAzureMonitor(),
// which first-party code reaches neither directly nor through a
// global-provider TelemetryClient.
const instrumentationHttpRule = {
	name: "@opentelemetry/instrumentation-http",
	floor: "0.222.0",
	advisory: "GHSA-3v2p-hm54-8qcq",
	reviewed: { "0.221.0": ["@azure/monitor-opentelemetry@1.20.1"] },
};

test("instrumentation-http exception permits only the reviewed Azure Monitor copy", () => {
	belowFloorRuleChecks(instrumentationHttpRule, "0.223.2", "0.220.0");
});

/** The text between a call's balanced parentheses, starting at its "(". */
function callArguments(source, open) {
	let depth = 0;
	for (let index = open; index < source.length; index++) {
		if (source[index] === "(") {
			depth++;
		} else if (source[index] === ")" && --depth === 0) {
			return source.slice(open + 1, index);
		}
	}
	return null;
}

// The reviewed construct: the only TelemetryClient constructed anywhere in the
// file is `new appInsights.TelemetryClient(connectionString, {
// useGlobalProviders: false })`, which the shim serves from an isolated
// TelemetryClientProvider instead of useAzureMonitor().
function verifyIsolatedTelemetryClient(source) {
	const calls = [...source.matchAll(/\bTelemetryClient\s*\(/g)];
	if (calls.length !== 1) {
		return [
			`expected one TelemetryClient construction, found ${calls.length}`,
		];
	}
	// The pinned `appInsights` lines fix the receiver; this fixes the options.
	const [call] = calls;
	const options = callArguments(source, call.index + call[0].length - 1)
		?.replace(/\/\/[^\n]*/g, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\s+/g, "");
	return options === "connectionString,{useGlobalProviders:false,}"
		? []
		: [
				`TelemetryClient options are not the reviewed isolated client: ${options}`,
			];
}

// Azure Monitor registers its instrumentations only through useAzureMonitor(),
// which the applicationinsights shim calls from setup()/start(), from
// defaultClient and global-provider TelemetryClients, and from its agent.
// Every first-party line that names applicationinsights, Azure Monitor or
// useAzureMonitor, in any letter case, must be a reviewed line in a reviewed
// file. In the two files that hold the loaded module, every line naming its
// binding is reviewed too, and the one constructor call is checked.
const azureMonitorScan = {
	label: "Application Insights or Azure Monitor",
	pattern:
		/applicationinsights|@azure\/monitor-opentelemetry|useAzureMonitor/i,
	sites: {
		// The isolated manual client (app-insights.ts:262-305, 927-931).
		"packages/observability/lib/app-insights.ts": {
			lines: {
				"* `applicationinsights` package and its transitive deps.": 1,
				"*   - trackTrace: node_modules/applicationinsights/out/src/shim/telemetryClient.d.ts:47": 1,
				"*   - trackException: node_modules/applicationinsights/out/src/shim/telemetryClient.d.ts:52": 1,
				"*   - trackException's own `severity` field: node_modules/applicationinsights/": 1,
				"*     node_modules/applicationinsights/out/src/declarations/generated/models/index.d.ts:296-302": 1,
				"const raw = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;": 1,
				"const appInsights = loadApplicationInsights();": 1,
				"function loadApplicationInsights(": 1,
				'): typeof import("applicationinsights") {': 1,
				'? testBundleRequire("applicationinsights")': 1,
				': bundleRequire("applicationinsights")': 1,
				') as typeof import("applicationinsights");': 2,
				'"applicationinsights",': 1,
				"* field on the installed shim: node_modules/applicationinsights/out/src/": 1,
				"export function __loadApplicationInsightsForTests(": 1,
				"return loadApplicationInsights(testBundleRequire, testObservabilityRequire);": 1,
			},
			bound: [
				{
					pattern: /\bappInsights\b/,
					lines: {
						"const appInsights = loadApplicationInsights();": 1,
						"return new appInsights.TelemetryClient(connectionString, {": 1,
					},
				},
			],
			verify: verifyIsolatedTelemetryClient,
		},
		// Loader tests: stubs, and one real load that only reads TelemetryClient.
		"packages/observability/__tests__/app-insights.test.ts": {
			lines: {
				'"APPLICATIONINSIGHTS_CONNECTION_STRING",': 1,
				"process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =": "*",
				'process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "garbage";':
					"*",
				"const { __loadApplicationInsightsForTests } = await import(": 4,
				"const loaded = __loadApplicationInsightsForTests(": 2,
				'expect(loadFromBundle).toHaveBeenCalledWith("applicationinsights");': 1,
				'"applicationinsights",': 1,
				"__loadApplicationInsightsForTests(() => {": 1,
				"const appInsights = __loadApplicationInsightsForTests() as {": 1,
			},
			bound: [
				{
					pattern: /\bappInsights\b/,
					lines: {
						"const appInsights = __loadApplicationInsightsForTests() as {": 1,
						'expect(appInsights.TelemetryClient).toBeTypeOf("function");': 1,
					},
				},
			],
		},
		// Build-time resolution and bundler externals; nothing is loaded
		// (apps/web/next.config.ts:21-25, 613-614).
		"apps/web/next.config.ts": {
			lines: {
				"function assertApplicationInsightsExternalResolvable(): void {": 1,
				'require.resolve("applicationinsights");': 1,
				"assertApplicationInsightsExternalResolvable();": 1,
				'"applicationinsights",': 1,
				'"applicationinsights-native-metrics",': 1,
			},
		},
		// .NET package-name patterns for stack detection (repo-stack.ts:52, 75).
		"packages/instructions/src/repo-stack.ts": {
			lines: {
				"/^aspire\\.hosting\\.azure\\.applicationinsights/i,": 1,
				"/^microsoft\\.applicationinsights|^azure\\.monitor\\.opentelemetry/i,": 1,
			},
		},
		// A comment naming the connection-string variable (worker.ts:649).
		"packages/temporal/src/worker.ts": {
			lines: {
				"// + safe; no-ops when APPLICATIONINSIGHTS_CONNECTION_STRING is unset.": 1,
			},
		},
	},
};

test("Application Insights scan fails on extra importers, aliases and global providers", () => {
	const libraryPath = "packages/observability/lib/app-insights.ts";
	const library = readFileSync(join(root, libraryPath), "utf8");
	const reviewedFiles = Object.fromEntries(
		Object.keys(azureMonitorScan.sites).map((path) => [
			path,
			readFileSync(join(root, path), "utf8"),
		]),
	);
	const scanTree = (files) =>
		withTree({ ...reviewedFiles, ...files }, (cwd) =>
			reviewedSiteFindings(azureMonitorScan, { cwd, noIndex: true }),
		);
	assert.deepEqual(scanTree({}).findings, []);
	const cases = [
		[
			"destructured alias import",
			{
				"apps/web/telemetry.ts":
					'import { setup as s, start } from "applicationinsights";\ns().start();',
			},
			/apps\/web\/telemetry\.ts: unreviewed/,
		],
		[
			"destructured alias require",
			{
				"packages/api/telemetry.cjs":
					'const { setup: s } = require("applicationinsights");\ns();',
			},
			/packages\/api\/telemetry\.cjs: unreviewed/,
		],
		[
			"multi-line named import",
			{
				"apps/web/client.ts":
					'import {\n\tdefaultClient,\n} from "applicationinsights";',
			},
			/apps\/web\/client\.ts: unreviewed/,
		],
		[
			"dynamic import with other letter case",
			{ "apps/web/dynamic.mjs": 'await import("ApplicationInsights");' },
			/dynamic\.mjs: unreviewed/,
		],
		[
			"useAzureMonitor",
			{ "apps/web/monitor.ts": "useAzureMonitor(options);" },
			/monitor\.ts: unreviewed/,
		],
		[
			"Azure Monitor import",
			{
				"apps/web/monitor.ts":
					'export * from "@azure/monitor-opentelemetry/sub";',
			},
			/monitor\.ts: unreviewed/,
		],
		[
			"bare string",
			{ "apps/web/name.ts": 'const name = "applicationinsights";' },
			/name\.ts: unreviewed/,
		],
		[
			"destructured alias in the reviewed file",
			{
				[libraryPath]: library.replace(
					"const appInsights = loadApplicationInsights();",
					"const appInsights = loadApplicationInsights();\n\tconst { setup: s } = loadApplicationInsights();",
				),
			},
			/unreviewed .*: const \{ setup: s \} = loadApplicationInsights\(\);/,
		],
		[
			"binding used for setup in the reviewed file",
			{
				[libraryPath]: library.replace(
					"const appInsights = loadApplicationInsights();",
					"const appInsights = loadApplicationInsights();\n\tappInsights.setup(connectionString).start();",
				),
			},
			/unreviewed use of \\bappInsights\\b: appInsights\.setup/,
		],
		[
			"global providers",
			{
				[libraryPath]: library.replace(
					/(TelemetryClient\(connectionString, \{[\s\S]*?useGlobalProviders: )false/,
					"$1true",
				),
			},
			/not the reviewed isolated client/,
		],
		[
			"second client",
			{
				[libraryPath]: `${library}\nconst other = new client.TelemetryClient(c);\n`,
			},
			/expected one TelemetryClient construction, found 2/,
		],
		[
			"auto-attach agent",
			{
				"apps/web/agent.ts":
					'import "applicationinsights/out/src/agent/agentLoader";',
			},
			/agent\.ts: unreviewed/,
		],
	];
	for (const [label, files, expected] of cases) {
		const { findings } = scanTree(files);
		assert.ok(
			findings.some((finding) => expected.test(finding)),
			`${label}: ${JSON.stringify(findings)}`,
		);
	}
});

// Application Insights, and the Azure Monitor distro it loads, may enter the
// workspace only through reviewed importer dependencies, whatever name or
// alias they are installed under.
const azureMonitorPackages = new Set([
	"applicationinsights",
	"@azure/monitor-opentelemetry",
]);
const reviewedAzureMonitorImporters = new Set([
	// The isolated manual client (packages/observability/lib/app-insights.ts).
	"packages/observability applicationinsights",
	// Build-time require.resolve and bundler externals only
	// (apps/web/next.config.ts:21-25, 613-614).
	"apps/web applicationinsights",
]);

function verifyAzureMonitorImporters(lockfile) {
	const found = [];
	for (const reference of requireLockfile(lockfile).references) {
		if (reference.section !== "importers") {
			continue;
		}
		const resolved = reference.target?.name;
		if (
			!azureMonitorPackages.has(reference.name) &&
			!azureMonitorPackages.has(resolved)
		) {
			continue;
		}
		const site = `${reference.owner} ${reference.name}`;
		if (
			!reviewedAzureMonitorImporters.has(site) ||
			resolved !== reference.name
		) {
			assert.fail(
				`Unreviewed Application Insights or Azure Monitor dependency: ${reference.label} -> ${reference.reference}`,
			);
		}
		found.push(site);
	}
	assert.deepEqual(
		[...new Set(found)].sort(),
		[...reviewedAzureMonitorImporters].sort(),
		"Reviewed Application Insights importer dependencies changed",
	);
}

test("Application Insights and Azure Monitor enter the workspace only through reviewed importers", () => {
	const lockfile = readLockfile();
	verifyAzureMonitorImporters(lockfile);
	assertRejectsMalformed(verifyAzureMonitorImporters, lockfile);
	const real = mutableCopy(lockfile);
	const insights =
		real.importers["packages/observability"].dependencies
			.applicationinsights;
	const distro = Object.keys(real.snapshots).find((key) =>
		key.startsWith("@azure/monitor-opentelemetry@"),
	);
	assert.ok(distro, "Missing @azure/monitor-opentelemetry snapshot");
	for (const [label, importer, name, dependency] of [
		[
			"npm alias in another importer",
			"packages/example",
			"telemetry",
			{
				specifier: "npm:applicationinsights@^3.17.0",
				version: `applicationinsights@${insights.version}`,
			},
		],
		[
			"npm alias in a reviewed importer",
			"packages/observability",
			"insights-alias",
			{
				specifier: "npm:applicationinsights@^3.17.0",
				version: `applicationinsights@${insights.version}`,
			},
		],
		[
			"direct dependency in another importer",
			"packages/example",
			"applicationinsights",
			insights,
		],
		[
			"distro under its own name",
			"packages/observability",
			"@azure/monitor-opentelemetry",
			{
				specifier: "^1.20.1",
				version: distro.slice("@azure/monitor-opentelemetry@".length),
			},
		],
		[
			"distro aliased",
			"apps/web",
			"monitor",
			{
				specifier: "npm:@azure/monitor-opentelemetry@^1.20.1",
				version: distro,
			},
		],
		[
			"reviewed name resolved to another package",
			"packages/observability",
			"applicationinsights",
			{
				specifier: "npm:example-insights@1.0.0",
				version: "example-insights@1.0.0",
			},
		],
		[
			"local copy",
			"packages/example",
			"telemetry",
			{
				specifier: "file:vendor/applicationinsights",
				version: "applicationinsights@file:vendor/applicationinsights",
			},
		],
	]) {
		const bad = addPackage(mutableCopy(lockfile), "example-insights@1.0.0");
		bad.importers[importer] ??= {};
		for (const group of ["devDependencies", "optionalDependencies"]) {
			const groupBad = structuredClone(bad);
			groupBad.importers[importer][group] = {
				...groupBad.importers[importer][group],
				[name]: dependency,
			};
			assert.throws(
				() => verifyAzureMonitorImporters(validateLockfile(groupBad)),
				/Unreviewed Application Insights or Azure Monitor dependency/,
				`${label} (${group})`,
			);
		}
	}
	// A reviewed importer that drops its dependency changes the reviewed set.
	const removed = mutableCopy(lockfile);
	delete removed.importers["apps/web"].dependencies.applicationinsights;
	assert.throws(
		() => verifyAzureMonitorImporters(validateLockfile(removed)),
		/Reviewed Application Insights importer dependencies changed/,
	);
});

test("first-party code never registers the Azure Monitor instrumentations", () => {
	const { findings, files } = reviewedSiteFindings(azureMonitorScan);
	assert.deepEqual(findings, []);
	assert.deepEqual(files.sort(), Object.keys(azureMonitorScan.sites).sort());
	// With global providers off the shim builds a TelemetryClientProvider,
	// which loads exporters and SDK providers but no instrumentation.
	for (const parent of installedConsumers("applicationinsights", "3.17.0")) {
		const client = readFileSync(
			parent.require.resolve("./out/src/shim/telemetryClient.js"),
			"utf8",
		);
		assert.match(
			client,
			/if \(this\._useGlobalProviders\) \{\s*\(0, main_1\.useAzureMonitor\)\(this\._options\);\s*\}\s*else \{\s*this\._telemetryClientProvider = new telemetryClientProvider_1\.TelemetryClientProvider/,
		);
		const provider = readFileSync(
			parent.require.resolve("./out/src/shim/telemetryClientProvider.js"),
			"utf8",
		);
		const requires = [...provider.matchAll(/require\("([^"]+)"\)/g)].map(
			(match) => match[1],
		);
		assert.ok(requires.length > 0, "provider source not read");
		assert.deepEqual(
			requires.filter((name) =>
				/instrumentation|^@azure\/monitor-opentelemetry$|\/main$/.test(
					name,
				),
			),
			[],
		);
	}
});

// GHSA-fc5q-39xc-vjpf: no fixed picomatch release exists (the advisory covers
// every version through 4.0.7, the latest). The ignore is ID-wide, so pin it to
// the reviewed resolutions: a new copy, including a later release, fails here
// until it is reviewed and added.
const reviewedPicomatchVersions = new Set(["2.3.2", "4.0.4", "4.0.5"]);

function isReviewedPicomatchVersion(version) {
	return reviewedPicomatchVersions.has(version);
}

function verifyPicomatchLockfile(lockfile) {
	requireLockfile(lockfile);
	for (const section of ["packages", "snapshots"]) {
		const entries = entriesNamed(lockfile, section, "picomatch");
		assert.ok(
			entries.length,
			`No picomatch entries in lockfile ${section}`,
		);
		for (const { key, version } of entries) {
			assert.ok(
				isReviewedPicomatchVersion(version),
				`Unreviewed picomatch resolution: ${key} (${section}); GHSA-fc5q-39xc-vjpf is dismissed only for reviewed versions`,
			);
		}
	}
}

// The ReDoS needs an attacker-supplied glob pattern. First-party code passes
// no patterns to picomatch because it names none of the libraries that compile
// one; every remaining consumer gets its patterns from package code or
// repository config. The scan matches any quoted module specifier for those
// packages, including subpaths, so an import split across lines, a re-export
// or a require() is caught too; a similarly named package is not. No site is
// reviewed, so any match fails.
const globCompilerScan = {
	label: "glob-compiling library",
	pattern:
		/["'](?:picomatch|micromatch|anymatch|fast-glob|tinyglobby|chokidar|fdir|readdirp)(?:\/[^"']*)?["']/,
	sites: {},
};

test("picomatch exception permits only reviewed versions", () => {
	for (const version of ["2.3.2", "4.0.4", "4.0.5"]) {
		assert.equal(isReviewedPicomatchVersion(version), true);
	}
	for (const version of [
		"2.3.1",
		"4.0.3",
		"4.0.6",
		"4.0.7",
		"4.0.8",
		"5.0.0",
		"4.0.5-beta.1",
		"invalid",
	]) {
		assert.equal(isReviewedPicomatchVersion(version), false);
	}
});

test("picomatch lockfile guard rejects missing and unreviewed entries", () => {
	const snippet = (version) =>
		parseLockfile(
			syntheticLockfile({
				packages: { [`picomatch@${version}`]: {} },
				snapshots: { [`picomatch@${version}`]: {} },
			}),
		);
	assert.doesNotThrow(() => verifyPicomatchLockfile(snippet("4.0.5")));
	assert.throws(
		() => verifyPicomatchLockfile(snippet("4.0.7")),
		/Unreviewed picomatch resolution/,
	);
	for (const text of [
		"packages: [",
		"",
		"packages: {}\nsnapshots: {}",
		"packages: {}",
		"packages: null\nsnapshots: null",
		"packages: []\nsnapshots: []",
	]) {
		assert.throws(
			() => verifyPicomatchLockfile(parseLockfile(text)),
			/could not check/,
			text,
		);
	}
	assert.throws(
		() => verifyPicomatchLockfile(zodSnippet("4.6.7")),
		/No picomatch entries/,
	);
	const lockfile = readLockfile();
	verifyPicomatchLockfile(lockfile);
	assertRejectsMalformed(verifyPicomatchLockfile, lockfile);
	for (const key of ["picomatch@4.0.7", "picomatch@file:vendor/picomatch"]) {
		assert.throws(
			() =>
				verifyPicomatchLockfile(
					validateLockfile(addPackage(mutableCopy(lockfile), key)),
				),
			/Unreviewed picomatch resolution: picomatch@/,
			key,
		);
	}
});

test("tracked first-party source names no glob-compiling library", () => {
	assert.deepEqual(reviewedSiteFindings(globCompilerScan).findings, []);
	assert.ok(
		reviewedSiteFindings({
			label: "nunjucks",
			pattern: /["']nunjucks["']/,
			sites: {},
		}).files.length > 0,
		"found no first-party nunjucks import; the scan is not reading first-party sources",
	);
	const caught = [
		["a.ts", 'import picomatch from "picomatch";'],
		["b.mjs", "const fg = require('fast-glob');"],
		["c.tsx", 'const m = await import("micromatch");'],
		["d.ts", 'import parse from\n\t"picomatch";'],
		["e.ts", 'import parse from "picomatch/lib/parse.js";'],
		["f.ts", 'export { glob } from "tinyglobby";'],
	];
	const { findings } = withTree(
		Object.fromEntries([
			...caught,
			["g.ts", 'import x from "picomatch-extra";'],
			["h.ts", 'import x from "my-micromatch";'],
		]),
		(cwd) => reviewedSiteFindings(globCompilerScan, { cwd, noIndex: true }),
	);
	assert.deepEqual(
		findings.map((finding) => finding.split(":")[0]).sort(),
		caught.map(([name]) => name),
		findings.join("\n"),
	);
});

test("each immediate parent's original range accepts the locked security version", () => {
	for (const [dependency, version, consumers] of [
		["proxy-addr", "2.0.8", proxyConsumers],
		["source-map-js", "1.2.2", sourceMapConsumers],
	]) {
		for (const [name, parentVersion] of consumers) {
			for (const { require, manifest } of installedConsumers(
				name,
				parentVersion,
			)) {
				verifyParentRange(manifest, dependency, version);
				assert.equal(
					require(`${dependency}/package.json`).version,
					version,
				);
				assert.throws(() =>
					verifyParentRange(
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
	const lockfile = readLockfile();
	verifyMetadata(lockfile);
	assertRejectsMalformed(verifyMetadata, lockfile);
	for (const [name, version] of [
		["proxy-addr", "2.0.7"],
		["source-map-js", "1.2.1"],
	]) {
		const mutated = addPackage(mutableCopy(lockfile), `${name}@${version}`);
		const owner = Object.keys(mutated.snapshots).find((key) =>
			Object.hasOwn(mutated.snapshots[key].dependencies ?? {}, name),
		);
		mutated.snapshots[owner].dependencies[name] = version;
		assert.throws(
			() => verifyMetadata(validateLockfile(mutated)),
			new RegExp(
				`${name}@${version.replace(/[.]/g, "\\.")}|reference from`,
			),
			owner,
		);
		const extra = addPackage(
			mutableCopy(lockfile),
			"example-parent@1.0.0",
			{
				dependencies: {
					[name]: name === "proxy-addr" ? "2.0.8" : "1.2.2",
				},
			},
		);
		assert.throws(
			() => verifyMetadata(validateLockfile(extra)),
			/Missing or unreviewed .* consumers/,
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
