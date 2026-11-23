// The one pnpm-lock.yaml reader for the dependency security guards.
//
// A guard that reads a lockfile it does not understand has not checked it, so
// this reader parses the YAML and validates it against the pnpm 9 lockfile
// shape pnpm 11.28.6 writes, including referential integrity between
// snapshots, package records and references. Any deviation, including invalid YAML,
// throws "could not check: <reason>" instead of being treated as empty.
// Guards receive only the validated structure: every accessor here, and every
// guard that calls `requireLockfile`, refuses a plain parsed object.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installedConsumers } from "./installed-consumers.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const lockfilePath = join(root, "pnpm-lock.yaml");
const yaml = installedConsumers("@changesets/parse", "1.0.0")[0].require(
	"yaml",
);
export const semver = installedConsumers("@changesets/cli", "3.0.1")[0].require(
	"semver",
);

const dependencyGroups = Object.freeze([
	"dependencies",
	"devDependencies",
	"optionalDependencies",
]);

// The schema is the lockfile pnpm 11.28.6 writes (dist/pnpm.mjs in
// @pnpm/exe 11.28.6): root keys from ROOT_KEYS (:199553-199563) plus the
// `snapshots`, `time` and `ignoredOptionalDependencies` keys normalizeLockfile
// and omitEmptyLockfileSettings keep (:199616-199672); importer fields from
// normalizeImporter (:199633-199650); package and snapshot fields from
// splitPackageSnapshots (:199585-199614). Each accepted field has a type check,
// and a field outside these sets fails, so a dependency group pnpm adds later
// cannot hold references the guards never read.
const isString = (value) => typeof value === "string" && value.length > 0;
const isBoolean = (value) => typeof value === "boolean";
const isStringArray = (value) => Array.isArray(value) && value.every(isString);
const isMappingOf = (test) => (value) =>
	isMapping(value) && Object.values(value).every(test);
// Fields checked by their own validation below.
const separate = "validated separately";
const dependencyMapping = separate;
const topLevelFields = {
	lockfileVersion: separate,
	settings: isMappingOf(
		(value) =>
			isBoolean(value) || isString(value) || typeof value === "number",
	),
	catalogs: isMappingOf(isMapping),
	overrides: isMappingOf(isString),
	packageExtensionsChecksum: isString,
	pnpmfileChecksum: isString,
	untrackedPnpmfileReadPackageHook: isBoolean,
	patchedDependencies: separate,
	ignoredOptionalDependencies: isStringArray,
	time: isMappingOf(isString),
	importers: separate,
	packages: separate,
	snapshots: separate,
};
const sectionFields = {
	importers: {
		dependencies: dependencyMapping,
		devDependencies: dependencyMapping,
		optionalDependencies: dependencyMapping,
		dependenciesMeta: isMappingOf(isMapping),
		publishDirectory: isString,
		// normalizeImporter writes linkDirectory only when it is false.
		linkDirectory: (value) => value === false,
	},
	packages: {
		resolution: separate,
		name: isString,
		version: isString,
		engines: isMappingOf(isString),
		cpu: isStringArray,
		os: isStringArray,
		libc: isStringArray,
		deprecated: isString,
		hasBin: isBoolean,
		bundledDependencies: (value) => value === true || isStringArray(value),
		peerDependencies: dependencyMapping,
		peerDependenciesMeta: isMappingOf(isMapping),
	},
	snapshots: {
		dependencies: dependencyMapping,
		optionalDependencies: dependencyMapping,
		transitivePeerDependencies: isStringArray,
		optional: isBoolean,
		id: isString,
	},
};
const sectionDependencyGroups = {
	importers: dependencyGroups,
	packages: ["peerDependencies"],
	snapshots: ["dependencies", "optionalDependencies"],
};
// Non-registry resolution types the writer emits: git (:139691), directory
// (:148888), variations (:125723) and binary (:125867).
const resolutionTypes = new Set(["git", "directory", "variations", "binary"]);
const packageName = /^(?:@[^@/()\s]+\/)?[^@/()\s]+$/;
const npmAlias = /^npm:((?:@[^@/()\s]+\/)?[^@/()\s]+)@/;
const keyPattern = /^((?:@[^@/()\s]+\/)?[^@/()\s]+)@([^()\s]*)(.*)$/s;
// A non-registry version in a dependency path, such as `file:../x`, a tarball
// URL or a registry-qualified version; pnpm's parser accepts any non-semver
// version (:145440-145470). Parentheses are refused so the peer suffix split
// matches pnpm's removeSuffix (:145374).
const nonSemverVersion = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s()]+$/;

const validated = new WeakSet();
const sources = new WeakMap();

function couldNotCheck(reason) {
	assert.fail(`could not check: ${reason}`);
}

function isMapping(value) {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function requireMappingValue(value, label) {
	if (!isMapping(value)) {
		couldNotCheck(`${label} is not a mapping`);
	}
	return value;
}

function requireString(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		couldNotCheck(`${label} is not a non-empty string`);
	}
	return value;
}

function requireKnownFields(value, allowed, label) {
	for (const field of Object.keys(value)) {
		if (!Object.hasOwn(allowed, field)) {
			couldNotCheck(`${label} has unknown field ${field}`);
		}
		const check = allowed[field];
		if (typeof check === "function" && !check(value[field])) {
			couldNotCheck(`${label} field ${field} has the wrong type`);
		}
	}
}

// A peer suffix is a run of balanced parenthesized groups, possibly nested:
// `(react@19.2.0)(ws@8.21.3(bufferutil@4.0.9))`.
function isPeerSuffix(suffix) {
	let depth = 0;
	let groupStart = -1;
	for (let index = 0; index < suffix.length; index++) {
		const character = suffix[index];
		if (depth === 0 && character !== "(") {
			return false;
		}
		if (character === "(") {
			if (depth === 0) {
				groupStart = index;
			}
			depth++;
		} else if (character === ")") {
			depth--;
			if (depth === 0 && index === groupStart + 1) {
				return false;
			}
		}
	}
	return depth === 0;
}

/**
 * `version(peer suffix)` as `{ version, source, suffix }`: `version` is the
 * canonical semver, or null for a non-registry source such as `file:`; null
 * when neither parses.
 */
/**
 * A strict semver written in canonical form, build metadata included:
 * `semver.valid` drops `+build`, so comparing against it rejected a valid
 * registry version such as `1.0.0+build.1`, which pnpm keeps in the key.
 */
function isCanonicalSemver(text) {
	const parsed = semver.parse(text);
	if (!parsed) {
		return false;
	}
	const build = parsed.build.length > 0 ? `+${parsed.build.join(".")}` : "";
	return `${parsed.version}${build}` === text;
}

const parsedVersions = new Map();
function parseVersion(text) {
	if (!parsedVersions.has(text)) {
		parsedVersions.set(text, parseVersionUncached(text));
	}
	return parsedVersions.get(text);
}

function parseVersionUncached(text) {
	const open = text.indexOf("(");
	const source = open === -1 ? text : text.slice(0, open);
	const suffix = open === -1 ? "" : text.slice(open);
	if (!isPeerSuffix(suffix)) {
		return null;
	}
	if (isCanonicalSemver(source)) {
		return Object.freeze({ version: source, source, suffix });
	}
	if (nonSemverVersion.test(source)) {
		return Object.freeze({ version: null, source, suffix });
	}
	return null;
}

function parseKey(key, label) {
	const match = keyPattern.exec(key);
	const parsed = match && parseVersion(match[2] + match[3]);
	if (!parsed) {
		couldNotCheck(
			`${label} key ${JSON.stringify(key)} is not name@version`,
		);
	}
	return {
		key,
		name: match[1],
		...parsed,
		// The package record a snapshot belongs to (removeSuffix, :145374).
		packageKey: `${match[1]}@${parsed.source}`,
	};
}

// The dependency path a reference names: pnpm's refToRelative (:145418-145431).
function referenceDependencyPath(name, reference) {
	if (reference.startsWith("link:")) {
		return null;
	}
	if (reference[0] === "@") {
		return reference;
	}
	const at = reference.indexOf("@");
	if (at === -1) {
		return `${name}@${reference}`;
	}
	const colon = reference.indexOf(":");
	const bracket = reference.indexOf("(");
	if ((colon === -1 || at < colon) && (bracket === -1 || at < bracket)) {
		return reference;
	}
	return `${name}@${reference}`;
}

// A reference is a workspace `link:<path>` (target null) or a dependency path
// that parses as name@version, which is its target.
function parseReference(name, value, label) {
	const path = referenceDependencyPath(name, value);
	if (path === null) {
		if (value.length === "link:".length) {
			couldNotCheck(`${label} ${JSON.stringify(value)} links nowhere`);
		}
		return null;
	}
	const match = keyPattern.exec(path);
	const parsed = match && parseVersion(match[2] + match[3]);
	if (!parsed) {
		couldNotCheck(`${label} ${JSON.stringify(value)} is not a version`);
	}
	return {
		name: match[1],
		version: parsed.version,
		source: parsed.source,
		dependencyPath: path,
	};
}

// A registry package (semver key) carries a tarball resolution with a
// non-empty integrity or tarball (toLockfileResolution, :198744-198790). A
// non-registry package carries one of the typed resolutions, or a tarball
// resolution; only a `file:` directory may omit it, because the reader then
// derives a directory resolution (convertToLockfileObject, :199695-199700;
// LOCAL_TARBALL_RE, :199798).
const localTarball = /\.(?:tgz|tar\.gz|tar|tar\.bz2|tbz2|tbz)$/i;
function validateResolution(entry, owner, label) {
	if (!Object.hasOwn(entry, "resolution")) {
		if (
			owner.source.startsWith("file:") &&
			!localTarball.test(owner.source)
		) {
			return;
		}
	}
	// A missing resolution fails here as not a mapping.
	const resolution = requireMappingValue(
		entry.resolution,
		`${label} resolution`,
	);
	for (const field of ["integrity", "tarball"]) {
		if (Object.hasOwn(resolution, field)) {
			requireString(resolution[field], `${label} resolution ${field}`);
		}
	}
	if (Object.hasOwn(resolution, "type")) {
		if (owner.version !== null || !resolutionTypes.has(resolution.type)) {
			couldNotCheck(
				`${label} resolution type ${JSON.stringify(resolution.type)} is not a reviewed non-registry type`,
			);
		}
		return;
	}
	if (
		!Object.hasOwn(resolution, "integrity") &&
		!Object.hasOwn(resolution, "tarball")
	) {
		couldNotCheck(`${label} resolution has neither integrity nor tarball`);
	}
}

function validateSection(raw, section) {
	const entries = requireMappingValue(raw[section], `lockfile ${section}`);
	if (Object.keys(entries).length === 0) {
		couldNotCheck(`lockfile ${section} is empty`);
	}
	const parsedEntries = [];
	const references = [];
	for (const [key, entry] of Object.entries(entries)) {
		const label = `${section} entry ${key}`;
		requireMappingValue(entry, label);
		requireKnownFields(entry, sectionFields[section], label);
		const owner =
			section === "importers" ? { key } : parseKey(key, section);
		if (section !== "importers") {
			parsedEntries.push(Object.freeze(owner));
		}
		if (section === "packages") {
			validateResolution(entry, owner, label);
			// pnpm prefers a record's explicit version over its key when it
			// builds a registry tarball URL (pnpm.mjs:198555), so a registry
			// record whose version disagrees with its key would let the guards
			// approve one version while pnpm fetches another. A differing
			// explicit name is rejected too, as a consistency check.
			if (owner.version !== null) {
				for (const [field, expected] of [
					["name", owner.name],
					["version", owner.version],
				]) {
					if (
						Object.hasOwn(entry, field) &&
						entry[field] !== expected
					) {
						couldNotCheck(
							`${label} ${field} ${JSON.stringify(entry[field])} disagrees with its key`,
						);
					}
				}
			}
		}
		for (const group of sectionDependencyGroups[section]) {
			if (!Object.hasOwn(entry, group)) {
				continue;
			}
			const dependencies = requireMappingValue(
				entry[group],
				`${label} ${group}`,
			);
			for (const [name, dependency] of Object.entries(dependencies)) {
				const dependencyLabel = `${label} ${group} ${name}`;
				if (!packageName.test(name)) {
					couldNotCheck(`${dependencyLabel} is not a package name`);
				}
				if (section === "packages") {
					// Peer ranges are reviewed by the guards as text only.
					requireString(dependency, dependencyLabel);
					continue;
				}
				let reference;
				let specifier;
				if (section === "importers") {
					requireMappingValue(dependency, dependencyLabel);
					requireKnownFields(
						dependency,
						{ specifier: separate, version: separate },
						dependencyLabel,
					);
					specifier = requireString(
						dependency.specifier,
						`${dependencyLabel} specifier`,
					);
					reference = requireString(
						dependency.version,
						`${dependencyLabel} version`,
					);
				} else {
					reference = requireString(dependency, dependencyLabel);
				}
				const target = parseReference(name, reference, dependencyLabel);
				// An `npm:` alias specifier must resolve to the package it names.
				const aliased = specifier && npmAlias.exec(specifier)?.[1];
				if (aliased && target?.name !== aliased) {
					couldNotCheck(
						`${dependencyLabel} specifier ${specifier} does not match version ${reference}`,
					);
				}
				references.push(
					Object.freeze({
						section,
						owner: key,
						ownerName: owner.name,
						ownerVersion: owner.version,
						group,
						name,
						reference,
						specifier,
						target: target && Object.freeze(target),
						label: dependencyLabel,
					}),
				);
			}
		}
	}
	return { entries: parsedEntries, references, owners: Object.keys(entries) };
}

// Every snapshot has its package record, and every registry reference names a
// snapshot, so a guard cannot pass because an entry it would reject is
// missing while something still depends on it.
function validateReferentialIntegrity(packages, snapshots, references) {
	const packageKeys = new Set(packages.entries.map((entry) => entry.key));
	const snapshotKeys = new Set(snapshots.entries.map((entry) => entry.key));
	for (const snapshot of snapshots.entries) {
		if (!packageKeys.has(snapshot.packageKey)) {
			couldNotCheck(
				`snapshot ${snapshot.key} has no package record ${snapshot.packageKey}`,
			);
		}
	}
	for (const reference of references) {
		if (
			reference.target !== null &&
			!reference.target.source.startsWith("file:") &&
			!snapshotKeys.has(reference.target.dependencyPath)
		) {
			couldNotCheck(
				`${reference.label} names missing snapshot ${reference.target.dependencyPath}`,
			);
		}
	}
}

/**
 * Validates a parsed lockfile and returns the frozen structure guards read:
 * `packages` and `snapshots` as `{ key, name, version, source, suffix }`
 * entries (`version` is null for a non-registry source), `importers` as owner
 * paths, every importer and snapshot dependency as a `reference` with its
 * resolved `target` (`null` for a workspace link), and `patchedDependencies`.
 */
export function validateLockfile(raw) {
	requireMappingValue(raw, "lockfile");
	if (raw.lockfileVersion !== "9.0") {
		couldNotCheck(
			`lockfileVersion ${JSON.stringify(raw.lockfileVersion)} is not the reviewed 9.0 format`,
		);
	}
	requireKnownFields(raw, topLevelFields, "lockfile");
	const importers = validateSection(raw, "importers");
	const packages = validateSection(raw, "packages");
	const snapshots = validateSection(raw, "snapshots");
	const references = [...importers.references, ...snapshots.references];
	validateReferentialIntegrity(packages, snapshots, references);
	const patchedDependencies = {};
	if (Object.hasOwn(raw, "patchedDependencies")) {
		for (const [key, hash] of Object.entries(
			requireMappingValue(
				raw.patchedDependencies,
				"lockfile patchedDependencies",
			),
		)) {
			patchedDependencies[key] = requireString(
				hash,
				`patchedDependencies ${key}`,
			);
		}
	}
	const lockfile = Object.freeze({
		importers: Object.freeze(importers.owners),
		packages: Object.freeze(packages.entries),
		snapshots: Object.freeze(snapshots.entries),
		references: Object.freeze(references),
		patchedDependencies: Object.freeze(patchedDependencies),
	});
	validated.add(lockfile);
	sources.set(lockfile, raw);
	return lockfile;
}

// Parsing the real lockfile takes seconds, and the result is frozen, so every
// guard in one test process shares it.
const parsedTexts = new Map();

/** Parses and validates lockfile text; a YAML error is "could not check". */
export function parseLockfile(text) {
	if (typeof text !== "string") {
		couldNotCheck("lockfile text is not readable");
	}
	const cached = parsedTexts.get(text);
	if (cached) {
		return cached;
	}
	let raw;
	try {
		const document = yaml.parseDocument(text, {
			strict: true,
			uniqueKeys: true,
		});
		const problems = [...document.errors, ...document.warnings];
		if (problems.length > 0) {
			throw problems[0];
		}
		raw = document.toJS({ maxAliasCount: 0 });
	} catch (error) {
		couldNotCheck(
			`lockfile is not valid YAML (${String(error?.message ?? error).split("\n")[0]})`,
		);
	}
	const lockfile = validateLockfile(raw);
	parsedTexts.set(text, lockfile);
	return lockfile;
}

export function readLockfile(path = lockfilePath) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		couldNotCheck(`${path} is not readable (${error.message})`);
	}
	return parseLockfile(text);
}

/** Every guard calls this first, so it never reads an unvalidated object. */
export function requireLockfile(lockfile) {
	if (!validated.has(lockfile)) {
		couldNotCheck("guard input is not a validated lockfile");
	}
	return lockfile;
}

/** `packages` or `snapshots` entries for one package name. */
export function entriesNamed(lockfile, section, name) {
	assert.ok(section === "packages" || section === "snapshots", section);
	return requireLockfile(lockfile)[section].filter(
		(entry) => entry.name === name,
	);
}

/** Importer and snapshot references that resolve to one package name. */
export function referencesTo(lockfile, name) {
	return requireLockfile(lockfile).references.filter(
		(reference) =>
			reference.name === name || reference.target?.name === name,
	);
}

/** A mutable plain copy for self-tests that build a modified lockfile. */
export function mutableCopy(lockfile) {
	requireLockfile(lockfile);
	return structuredClone(sources.get(lockfile));
}

/**
 * The guards compare versions only through these, so a prerelease never
 * satisfies a floor or escapes an affected range unless a guard lists it as
 * reviewed (semver.satisfies silently excludes prereleases from ranges).
 */
export function isStableVersion(version) {
	return (
		typeof version === "string" &&
		isCanonicalSemver(version) &&
		semver.prerelease(version) === null
	);
}

export function isStableAtLeast(version, floor) {
	return isStableVersion(version) && semver.gte(version, floor);
}

export function isStableOutside(version, affected) {
	return isStableVersion(version) && !semver.satisfies(version, affected);
}

const syntheticIntegrity = "sha512-c3ludGhldGlj";

function tryParseKey(key) {
	const match = typeof key === "string" && keyPattern.exec(key);
	const parsed = match && parseVersion(match[2] + match[3]);
	return parsed ? { name: match[1], ...parsed } : null;
}

/**
 * Adds a registry package record (if missing) and a snapshot to a raw lockfile,
 * so a self-test can introduce a package without breaking referential
 * integrity.
 */
export function addPackage(raw, key, snapshot = {}) {
	const parsed = tryParseKey(key);
	assert.ok(parsed, `synthetic key ${key} is not name@version`);
	raw.packages[`${parsed.name}@${parsed.source}`] ??= {
		resolution: { integrity: syntheticIntegrity },
	};
	raw.snapshots[key] = snapshot;
	return raw;
}

// Fills the package records, resolutions and referenced snapshots a small
// fixture leaves out. Entries that do not parse are left for the reader.
function completeLockfile(raw) {
	if (![raw.importers, raw.packages, raw.snapshots].every(isMapping)) {
		return raw;
	}
	for (const key of Object.keys(raw.snapshots)) {
		const parsed = tryParseKey(key);
		if (parsed) {
			raw.packages[`${parsed.name}@${parsed.source}`] ??= {};
		}
	}
	for (const [key, entry] of Object.entries(raw.packages)) {
		if (
			isMapping(entry) &&
			!Object.hasOwn(entry, "resolution") &&
			tryParseKey(key)
		) {
			entry.resolution = { integrity: syntheticIntegrity };
		}
	}
	const owners = [
		...Object.values(raw.importers).flatMap((entry) =>
			dependencyGroups.map((group) => [entry?.[group], true]),
		),
		...Object.values(raw.snapshots).flatMap((entry) =>
			["dependencies", "optionalDependencies"].map((group) => [
				entry?.[group],
				false,
			]),
		),
	];
	for (const [dependencies, importer] of owners) {
		if (!isMapping(dependencies)) {
			continue;
		}
		for (const [name, dependency] of Object.entries(dependencies)) {
			const reference = importer ? dependency?.version : dependency;
			if (typeof reference !== "string") {
				continue;
			}
			const path = referenceDependencyPath(name, reference);
			const parsed = path && tryParseKey(path);
			if (
				parsed &&
				!parsed.source.startsWith("file:") &&
				!Object.hasOwn(raw.snapshots, path)
			) {
				addPackage(raw, path);
			}
		}
	}
	return raw;
}

/**
 * Lockfile text around the given sections, for guard self-tests. Package
 * records, resolutions and referenced snapshots the fixture omits are filled
 * in, so a fixture states only what its test is about.
 */
export function syntheticLockfile({
	importers = { ".": {} },
	packages = {},
	snapshots = {},
	...rest
} = {}) {
	return yaml.stringify(
		completeLockfile({
			lockfileVersion: "9.0",
			importers: structuredClone(importers),
			packages: structuredClone(packages),
			snapshots: structuredClone(snapshots),
			...rest,
		}),
	);
}

// Malformed lockfiles for self-tests, each `[label, text | raw object]`. They
// cover every shape the schema above rejects, built from the real lockfile's
// own entries so the corruption sits where a guard would read.
export function malformedLockfiles(lockfile) {
	requireLockfile(lockfile);
	// The source object is only read here: each variant copies the sections
	// and the one entry it corrupts, which keeps 100 variants cheap.
	const base = sources.get(lockfile);
	const pick = (section, test) => {
		const found = Object.entries(base[section]).find(([, entry]) =>
			test(entry),
		)?.[0];
		assert.ok(found, `No ${section} entry to corrupt`);
		return found;
	};
	const importer = pick("importers", (entry) =>
		isMapping(entry.dependencies),
	);
	const dependency = Object.keys(base.importers[importer].dependencies)[0];
	const snapshot = pick("snapshots", (entry) =>
		isMapping(entry.dependencies),
	);
	const snapshotDependency = Object.keys(
		base.snapshots[snapshot].dependencies,
	)[0];
	const peerPackage = pick("packages", (entry) =>
		isMapping(entry.peerDependencies),
	);
	// The fixed HTTP instrumentation the GHSA-3v2p exception relies on.
	const fixedHttp = "@opentelemetry/instrumentation-http@0.223.2";
	assert.ok(Object.hasOwn(base.packages, fixedHttp), `Missing ${fixedHttp}`);
	const variants = [
		["invalid YAML", "lockfileVersion: '9.0'\npackages: ["],
		["empty document", ""],
		["duplicate key", "lockfileVersion: '9.0'\nlockfileVersion: '9.0'\n"],
		["multiple documents", "lockfileVersion: '9.0'\n---\nimporters: {}\n"],
		[
			"YAML alias",
			"lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages:\n  example@1.0.0: &entry\n    resolution: { integrity: sha512-c3ludGhldGlj }\n  other@1.0.0: *entry\nsnapshots:\n  example@1.0.0: {}\n",
		],
	];
	const variant = (label, mutate) => {
		const copy = {
			...base,
			importers: {
				...base.importers,
				[importer]: structuredClone(base.importers[importer]),
			},
			packages: {
				...base.packages,
				[peerPackage]: structuredClone(base.packages[peerPackage]),
			},
			snapshots: {
				...base.snapshots,
				[snapshot]: structuredClone(base.snapshots[snapshot]),
			},
		};
		const result = mutate(copy);
		variants.push([label, result === undefined ? copy : result]);
	};
	for (const [kind, value] of [
		["array", []],
		["scalar", "unreadable"],
		["null", null],
	]) {
		variant(`lockfile ${kind}`, () => value);
		for (const section of ["importers", "packages", "snapshots"]) {
			variant(`${section} ${kind}`, (copy) => {
				copy[section] = value;
			});
		}
		variant(`importer entry ${kind}`, (copy) => {
			copy.importers[importer] = value;
		});
		variant(`package entry ${kind}`, (copy) => {
			copy.packages[peerPackage] = value;
		});
		variant(`snapshot entry ${kind}`, (copy) => {
			copy.snapshots[snapshot] = value;
		});
		for (const group of dependencyGroups) {
			variant(`importer ${group} ${kind}`, (copy) => {
				copy.importers[importer][group] = value;
			});
		}
		for (const group of ["dependencies", "optionalDependencies"]) {
			variant(`snapshot ${group} ${kind}`, (copy) => {
				copy.snapshots[snapshot][group] = value;
			});
		}
		variant(`package peerDependencies ${kind}`, (copy) => {
			copy.packages[peerPackage].peerDependencies = value;
		});
		variant(`patchedDependencies ${kind}`, (copy) => {
			copy.patchedDependencies = value;
		});
	}
	for (const section of ["importers", "packages", "snapshots"]) {
		variant(`missing ${section}`, (copy) => {
			delete copy[section];
		});
		variant(`empty ${section}`, (copy) => {
			copy[section] = {};
		});
	}
	variant("missing lockfileVersion", (copy) => {
		delete copy.lockfileVersion;
	});
	variant("other lockfileVersion", (copy) => {
		copy.lockfileVersion = "6.0";
	});
	variant("numeric lockfileVersion", (copy) => {
		copy.lockfileVersion = 9;
	});
	variant("unknown top-level field", (copy) => {
		copy.unreviewedSection = {};
	});
	variant("unknown importer field", (copy) => {
		copy.importers[importer].peerDependencies = {};
	});
	variant("unknown package field", (copy) => {
		copy.packages[peerPackage].dependencies = {};
	});
	variant("unknown snapshot field", (copy) => {
		copy.snapshots[snapshot].peerDependencies = {};
	});
	const importerDependency = (copy) => copy.importers[importer].dependencies;
	// Variants that must fail on one field keep a reference that resolves, so
	// referential integrity is not what rejects them.
	const current = base.importers[importer].dependencies[dependency].version;
	for (const [label, value] of [
		["scalar", "4.6.7"],
		["null", null],
		["array", []],
		["missing specifier", { version: current }],
		["numeric specifier", { specifier: 4, version: current }],
		["empty specifier", { specifier: "", version: current }],
		["missing version", { specifier: "^1.0.0" }],
		["numeric version", { specifier: "^1.0.0", version: 1 }],
		["empty version", { specifier: "^1.0.0", version: "" }],
		["unparseable version", { specifier: "^1.0.0", version: "latest" }],
		["prefixed version", { specifier: "^1.0.0", version: "v1.0.0" }],
		[
			"alias specifier with a plain version",
			{ specifier: "npm:example-target@^1.0.0", version: current },
		],
		[
			"alias specifier with another target",
			{ specifier: "npm:example-target@^1.0.0", version: snapshot },
		],
		[
			"extra field",
			{ specifier: "^1.0.0", version: current, resolved: current },
		],
	]) {
		variant(`importer dependency ${label}`, (copy) => {
			importerDependency(copy)[dependency] = value;
		});
	}
	variant("importer dependency name", (copy) => {
		importerDependency(copy)["not a package"] = {
			specifier: "^1.0.0",
			version: "1.0.0",
		};
	});
	variant("snapshot dependency name", (copy) => {
		copy.snapshots[snapshot].dependencies["@scope/"] = "1.0.0";
	});
	variant("package peer dependency name", (copy) => {
		copy.packages[peerPackage].peerDependencies["(peer)"] = "^1.0.0";
	});
	for (const [label, value] of [
		["numeric", 1],
		["empty", ""],
		["null", null],
		["mapping", { version: "1.0.0" }],
		["unparseable", "latest"],
		["unbalanced suffix", "1.0.0(react@19.2.0"],
		["empty link", "link:"],
	]) {
		variant(`snapshot dependency ${label}`, (copy) => {
			copy.snapshots[snapshot].dependencies[snapshotDependency] = value;
		});
	}
	for (const [label, value] of [
		["numeric", 1],
		["empty", ""],
	]) {
		variant(`package peer dependency ${label}`, (copy) => {
			const peers = copy.packages[peerPackage].peerDependencies;
			peers[Object.keys(peers)[0]] = value;
		});
		variant(`patchedDependencies value ${label}`, (copy) => {
			copy.patchedDependencies = { "example@1.0.0": value };
		});
	}
	for (const key of [
		"example",
		"example@",
		"example@latest",
		"example@v1.0.0",
		"example@1.0",
		"@scope/example",
		"example@1.0.0(peer@1.0.0",
		"example@1.0.0()",
		"example@1.0.0 (peer@1.0.0)",
		"example@1.0.0x",
		"example@1.0.0(peer@1.0.0)x",
	]) {
		// Each would pass the integrity checks if its key parsed.
		variant(`packages key ${JSON.stringify(key)}`, (copy) => {
			copy.packages[key] = {
				resolution: { integrity: syntheticIntegrity },
			};
		});
		variant(`snapshots key ${JSON.stringify(key)}`, (copy) => {
			copy.packages["example@1.0.0"] = {
				resolution: { integrity: syntheticIntegrity },
			};
			copy.snapshots[key] = {};
		});
	}
	// Referential integrity and resolutions.
	variant("package record deleted", (copy) => {
		delete copy.packages[fixedHttp];
	});
	for (const [label, resolution] of [
		["deleted", undefined],
		["false", false],
		["null", null],
		["empty", {}],
		["numeric integrity", { integrity: 1 }],
		["empty integrity", { integrity: "" }],
		["empty tarball", { tarball: "" }],
		["typed registry resolution", { type: "directory", directory: "x" }],
	]) {
		variant(`registry resolution ${label}`, (copy) => {
			const entry = { ...copy.packages[fixedHttp] };
			if (resolution === undefined) {
				delete entry.resolution;
			} else {
				entry.resolution = resolution;
			}
			copy.packages[fixedHttp] = entry;
		});
	}
	variant("unknown non-registry resolution type", (copy) => {
		copy.packages["example@https://example.com/example.tgz"] = {
			resolution: { type: "unreviewed" },
		};
	});
	variant("non-registry package without resolution", (copy) => {
		copy.packages["example@https://example.com/example.tgz"] = {};
	});
	variant("local tarball without resolution", (copy) => {
		copy.packages["example@file:vendor/example.tgz"] = {};
	});
	variant("snapshot without package record", (copy) => {
		copy.snapshots["example-orphan@1.0.0"] = {};
	});
	variant("dangling importer reference", (copy) => {
		importerDependency(copy)[dependency] = {
			specifier: "^999.0.0",
			version: "999.0.0",
		};
	});
	variant("dangling snapshot reference", (copy) => {
		copy.snapshots[snapshot].dependencies[snapshotDependency] = "999.0.0";
	});
	variant("dangling alias reference", (copy) => {
		copy.snapshots[snapshot].dependencies[snapshotDependency] =
			"example-missing@1.0.0";
	});
	// Each optional field the writer emits, with the wrong type.
	for (const [label, mutate] of [
		[
			"settings",
			(copy) => {
				copy.settings = [];
			},
		],
		[
			"catalogs",
			(copy) => {
				copy.catalogs = { default: "x" };
			},
		],
		[
			"overrides",
			(copy) => {
				copy.overrides = { example: 1 };
			},
		],
		[
			"packageExtensionsChecksum",
			(copy) => {
				copy.packageExtensionsChecksum = 1;
			},
		],
		[
			"pnpmfileChecksum",
			(copy) => {
				copy.pnpmfileChecksum = "";
			},
		],
		[
			"untrackedPnpmfileReadPackageHook",
			(copy) => {
				copy.untrackedPnpmfileReadPackageHook = "yes";
			},
		],
		[
			"ignoredOptionalDependencies",
			(copy) => {
				copy.ignoredOptionalDependencies = "example";
			},
		],
		[
			"time",
			(copy) => {
				copy.time = { "example@1.0.0": 1 };
			},
		],
		[
			"importer dependenciesMeta",
			(copy) => {
				copy.importers[importer].dependenciesMeta = { example: true };
			},
		],
		[
			"importer publishDirectory",
			(copy) => {
				copy.importers[importer].publishDirectory = 1;
			},
		],
		[
			"importer linkDirectory",
			(copy) => {
				copy.importers[importer].linkDirectory = true;
			},
		],
		[
			"package name",
			(copy) => {
				copy.packages[peerPackage].name = 1;
			},
		],
		[
			"package version",
			(copy) => {
				copy.packages[peerPackage].version = "";
			},
		],
		[
			"package engines",
			(copy) => {
				copy.packages[peerPackage].engines = { node: 22 };
			},
		],
		[
			"package cpu",
			(copy) => {
				copy.packages[peerPackage].cpu = "x64";
			},
		],
		[
			"package os",
			(copy) => {
				copy.packages[peerPackage].os = [1];
			},
		],
		[
			"package libc",
			(copy) => {
				copy.packages[peerPackage].libc = {};
			},
		],
		[
			"package deprecated",
			(copy) => {
				copy.packages[peerPackage].deprecated = true;
			},
		],
		[
			"package hasBin",
			(copy) => {
				copy.packages[peerPackage].hasBin = "true";
			},
		],
		[
			"package bundledDependencies",
			(copy) => {
				copy.packages[peerPackage].bundledDependencies = false;
			},
		],
		[
			"package peerDependenciesMeta",
			(copy) => {
				copy.packages[peerPackage].peerDependenciesMeta = {
					example: true,
				};
			},
		],
		[
			"package id",
			(copy) => {
				copy.packages[peerPackage].id = "example";
			},
		],
		[
			"snapshot transitivePeerDependencies",
			(copy) => {
				copy.snapshots[snapshot].transitivePeerDependencies = "example";
			},
		],
		[
			"snapshot optional",
			(copy) => {
				copy.snapshots[snapshot].optional = "true";
			},
		],
		[
			"snapshot id",
			(copy) => {
				copy.snapshots[snapshot].id = 1;
			},
		],
	]) {
		variant(`wrong type: ${label}`, mutate);
	}
	return variants;
}

/**
 * Asserts that `verify` refuses an unvalidated object and that every malformed
 * lockfile fails with "could not check" before the guard sees it.
 */
export function assertRejectsMalformed(verify, lockfile) {
	assert.throws(
		() => verify(mutableCopy(lockfile)),
		/could not check: guard input is not a validated lockfile/,
		"guard accepted an unvalidated object",
	);
	const variants = malformedLockfiles(lockfile);
	for (const [label, bad] of variants) {
		assert.throws(
			() =>
				verify(
					typeof bad === "string"
						? parseLockfile(bad)
						: validateLockfile(bad),
				),
			/could not check/,
			label,
		);
	}
}
