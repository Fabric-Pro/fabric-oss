import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	addPackage,
	entriesNamed,
	isStableAtLeast,
	isStableOutside,
	isStableVersion,
	malformedLockfiles,
	mutableCopy,
	parseLockfile,
	readLockfile,
	referencesTo,
	requireLockfile,
	syntheticLockfile,
	validateLockfile,
} from "./lockfile-shape.mjs";

test("the lockfile reader accepts the real lockfile and exposes parsed entries", () => {
	const lockfile = readLockfile();
	assert.ok(lockfile.importers.includes("."));
	assert.ok(lockfile.packages.length > 1000);
	assert.ok(lockfile.snapshots.length > 1000);
	const [zod] = entriesNamed(lockfile, "packages", "zod");
	assert.equal(zod.key, `zod@${zod.version}`);
	// Aliases resolve to their target, workspace links to null.
	assert.ok(
		lockfile.references.some(
			(reference) =>
				reference.target !== null &&
				reference.target.name !== reference.name,
		),
	);
	assert.ok(
		lockfile.references.some(
			(reference) =>
				reference.section === "importers" && reference.target === null,
		),
	);
	assert.ok(referencesTo(lockfile, "zod").length > 0);
	assert.ok(Object.isFrozen(lockfile));
	assert.ok(Object.isFrozen(lockfile.references[0]));
});

test("every malformed lockfile shape fails with could not check", () => {
	const lockfile = readLockfile();
	const variants = malformedLockfiles(lockfile);
	assert.ok(variants.length >= 100, `${variants.length} variants`);
	for (const [label, bad] of variants) {
		assert.throws(
			() =>
				typeof bad === "string"
					? parseLockfile(bad)
					: validateLockfile(bad),
			/could not check/,
			label,
		);
	}
	// The variants differ from the real lockfile only where they are corrupt.
	assert.doesNotThrow(() => validateLockfile(mutableCopy(lockfile)));
});

test("an unreadable or unvalidated lockfile fails with could not check", () => {
	const directory = mkdtempSync(join(tmpdir(), "lockfile-shape-"));
	try {
		assert.throws(
			() => readLockfile(join(directory, "missing.yaml")),
			/could not check: .* is not readable/,
		);
		const invalid = join(directory, "invalid.yaml");
		writeFileSync(invalid, "lockfileVersion: '9.0'\nimporters: [\n");
		assert.throws(
			() => readLockfile(invalid),
			/could not check: lockfile is not valid YAML/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
	assert.throws(
		() => parseLockfile(undefined),
		/could not check: lockfile text is not readable/,
	);
	for (const value of [
		mutableCopy(readLockfile()),
		{},
		null,
		Object.freeze({ packages: [] }),
	]) {
		assert.throws(
			() => requireLockfile(value),
			/could not check: guard input is not a validated lockfile/,
		);
	}
});

test("a registry record whose name or version disagrees with its key fails", () => {
	const key = "@opentelemetry/instrumentation-http@0.223.2";
	const matching = mutableCopy(readLockfile());
	assert.ok(matching.packages[key], `${key} is in the lockfile`);
	matching.packages[key].name = "@opentelemetry/instrumentation-http";
	matching.packages[key].version = "0.223.2";
	assert.doesNotThrow(() => validateLockfile(matching));
	for (const [field, value] of [
		["version", "0.221.0"],
		["name", "@opentelemetry/instrumentation-https"],
	]) {
		const raw = mutableCopy(readLockfile());
		raw.packages[key][field] = value;
		assert.throws(
			() => validateLockfile(raw),
			new RegExp(`could not check: .*${field} .* disagrees with its key`),
			field,
		);
	}
});

test("a registry version with build metadata is a valid stable version", () => {
	const raw = addPackage(
		mutableCopy(readLockfile()),
		"example-build@1.0.0+build.1",
	);
	const lockfile = validateLockfile(raw);
	const [entry] = entriesNamed(lockfile, "packages", "example-build");
	assert.equal(entry.version, "1.0.0+build.1");
	assert.equal(isStableVersion("1.0.0+build.1"), true);
	assert.equal(isStableAtLeast("1.0.0+build.1", "1.0.0"), true);
	// Still canonical only: a leading v or a loose form is not a registry key.
	assert.equal(isStableVersion("v1.0.0"), false);
});

test("lockfile keys keep nested peer suffixes and strip them from versions", () => {
	const lockfile = parseLockfile(
		syntheticLockfile({
			importers: {
				".": {
					dependencies: {
						alias: {
							specifier: "npm:@example/target@^1.0.0",
							version: "@example/target@1.2.3(peer@1.0.0)",
						},
						local: {
							specifier: "workspace:*",
							version: "link:packages/local",
						},
					},
				},
			},
			packages: { "@example/target@1.2.3": {}, "peer@1.0.0": {} },
			snapshots: {
				"@example/target@1.2.3(peer@1.0.0(inner@2.0.0))(other@3.0.0)": {
					dependencies: { peer: "1.0.0(inner@2.0.0)" },
				},
				"peer@1.0.0": {},
			},
		}),
	);
	const [snapshot] = entriesNamed(lockfile, "snapshots", "@example/target");
	assert.equal(snapshot.version, "1.2.3");
	assert.equal(snapshot.suffix, "(peer@1.0.0(inner@2.0.0))(other@3.0.0)");
	const [alias, local] = lockfile.references.filter(
		(reference) => reference.section === "importers",
	);
	assert.deepEqual(alias.target, {
		name: "@example/target",
		version: "1.2.3",
		source: "1.2.3",
		dependencyPath: "@example/target@1.2.3(peer@1.0.0)",
	});
	assert.equal(alias.specifier, "npm:@example/target@^1.0.0");
	assert.equal(local.target, null);
	const [peer] = referencesTo(lockfile, "peer");
	assert.equal(peer.ownerName, "@example/target");
	assert.equal(peer.ownerVersion, "1.2.3");
	assert.deepEqual(peer.target, {
		name: "peer",
		version: "1.0.0",
		source: "1.0.0",
		dependencyPath: "peer@1.0.0(inner@2.0.0)",
	});
});

// Every optional field and reference form pnpm 11.28.6 writes (see the schema
// comment in lockfile-shape.mjs) must still validate.
test("the reader accepts every field and reference form the pnpm writer emits", () => {
	const integrity = { integrity: "sha512-c3ludGhldGlj" };
	const raw = {
		lockfileVersion: "9.0",
		settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
		catalogs: {
			default: { react: { specifier: "^19.0.0", version: "19.2.0" } },
		},
		overrides: { example: "^1.0.0" },
		packageExtensionsChecksum: "sha256-example",
		pnpmfileChecksum: "sha256-example",
		untrackedPnpmfileReadPackageHook: true,
		patchedDependencies: { "example@1.0.0": "abc123" },
		ignoredOptionalDependencies: ["fsevents"],
		time: { "example@1.0.0": "2026-01-01T00:00:00.000Z" },
		importers: {
			".": {
				dependenciesMeta: { local: { injected: true } },
				dependencies: {
					example: { specifier: "^1.0.0", version: "1.0.0" },
					local: {
						specifier: "file:packages/local",
						version: "file:packages/local",
					},
					// An "@" after the scheme does not start an alias.
					"scoped-url": {
						specifier:
							"https://example.com/@example/scoped-url.tgz",
						version: "https://example.com/@example/scoped-url.tgz",
					},
					// A `file:` reference need not name a snapshot.
					vendored: {
						specifier: "file:vendor/vendored",
						version: "file:vendor/vendored",
					},
					tarball: {
						specifier: "file:vendor/tarball.tgz",
						version: "file:vendor/tarball.tgz",
					},
					remote: {
						specifier: "https://example.com/remote.tgz",
						version: "https://example.com/remote.tgz",
					},
					git: {
						specifier: "github:example/git",
						version:
							"https://codeload.github.com/example/git/tar.gz/abc123",
					},
				},
				publishDirectory: "dist",
				linkDirectory: false,
			},
			"packages/other": {},
		},
		packages: {
			"example@1.0.0": {
				resolution: integrity,
				engines: { node: ">=22" },
				cpu: ["x64"],
				os: ["linux"],
				libc: ["glibc"],
				deprecated: "use example 2",
				hasBin: true,
				bundledDependencies: ["inner"],
				peerDependencies: { peer: "^1.0.0" },
				peerDependenciesMeta: { peer: { optional: true } },
			},
			"bundled@1.0.0": {
				resolution: { tarball: "https://example.com/bundled.tgz" },
				bundledDependencies: true,
			},
			"local@file:packages/local": { name: "local", version: "0.0.0" },
			"scoped-url@https://example.com/@example/scoped-url.tgz": {
				resolution: {
					tarball: "https://example.com/@example/scoped-url.tgz",
				},
			},
			"tarball@file:vendor/tarball.tgz": {
				resolution: {
					integrity: "sha512-c3ludGhldGlj",
					tarball: "file:vendor/tarball.tgz",
				},
			},
			"vendored@file:vendor/vendored": {
				resolution: { type: "directory", directory: "vendor/vendored" },
			},
			"remote@https://example.com/remote.tgz": {
				resolution: { tarball: "https://example.com/remote.tgz" },
				name: "remote",
				version: "1.0.0",
			},
			"git@https://codeload.github.com/example/git/tar.gz/abc123": {
				resolution: {
					type: "git",
					repo: "https://github.com/example/git",
					commit: "abc123",
				},
				name: "git",
				version: "1.0.0",
			},
		},
		snapshots: {
			"example@1.0.0": {
				dependencies: {
					bundled: "1.0.0",
					local: "file:packages/local",
				},
				transitivePeerDependencies: ["peer"],
				optional: false,
				id: "example@1.0.0",
			},
			"bundled@1.0.0": {},
			"local@file:packages/local": {},
			"scoped-url@https://example.com/@example/scoped-url.tgz": {},
			"remote@https://example.com/remote.tgz": {},
			"git@https://codeload.github.com/example/git/tar.gz/abc123": {},
		},
	};
	const lockfile = validateLockfile(raw);
	const [local] = entriesNamed(lockfile, "packages", "local");
	assert.equal(local.version, null);
	assert.equal(local.source, "file:packages/local");
	assert.deepEqual(
		referencesTo(lockfile, "local").map(
			(reference) => reference.target.source,
		),
		["file:packages/local", "file:packages/local"],
	);
	// A non-registry source never satisfies a version predicate.
	assert.equal(isStableAtLeast(local.version, "0.0.0"), false);
});

test("version predicates reject prereleases unless a guard reviews them", () => {
	assert.equal(isStableVersion("1.2.3"), true);
	for (const version of ["1.2.3-rc.1", "v1.2.3", "1.2", "", undefined, 1]) {
		assert.equal(isStableVersion(version), false, String(version));
	}
	assert.equal(isStableAtLeast("2.0.0", "1.0.0"), true);
	assert.equal(isStableAtLeast("2.0.0-rc.1", "1.0.0"), false);
	assert.equal(isStableAtLeast("0.9.0", "1.0.0"), false);
	assert.equal(isStableOutside("1.24.0", ">=1.24.1 <=2.0.0"), true);
	for (const version of ["1.24.1", "2.0.0", "2.0.0-rc.1", "2.0.1-rc.1"]) {
		assert.equal(
			isStableOutside(version, ">=1.24.1 <=2.0.0"),
			false,
			version,
		);
	}
});
