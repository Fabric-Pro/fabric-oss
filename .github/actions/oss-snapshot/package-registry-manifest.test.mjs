import assert from "node:assert/strict";
import test from "node:test";
import { SNAPSHOT_IMAGES } from "./oss-snapshot-manifest.mjs";
import {
	expectedPackageNames,
	validatePackageRegistryManifest,
} from "./package-registry-manifest.mjs";

const sourceRepository = { fullName: "example-org/private-app", id: 100 };
const runtime = { fullName: sourceRepository.fullName, id: "100" };
const names = ["private-app-snapshots", "private-app-buildcache"].flatMap(
	(namespace) =>
		SNAPSHOT_IMAGES.map(({ component }) => `${namespace}/${component}`),
);
function bindings() {
	return {
		schemaVersion: 1,
		sourceRepository: { ...sourceRepository },
		packages: names.map((name, index) => ({
			name,
			id: 200 + index,
			packageType: "container",
		})),
	};
}
function metadata() {
	return {
		name: names[0],
		id: 200,
		package_type: "container",
		visibility: "private",
		repository: null,
	};
}
function validate(
	live = metadata(),
	approved = bindings(),
	identity = runtime,
	name = names[0],
) {
	return validatePackageRegistryManifest(live, name, approved, identity);
}

test("derives the complete package set from the fixed component catalog", () => {
	assert.deepEqual(expectedPackageNames(sourceRepository.fullName), names);
	assert.equal(new Set(names).size, 28);
});
test("accepts approved private package with undisclosed repository", () => {
	assert.doesNotThrow(() => validate());
});
test("accepts approved private package with omitted repository", () => {
	const live = metadata();
	delete live.repository;
	assert.doesNotThrow(() => validate(live));
});
test("omitted repository still requires exact live identity, privacy, and approved bindings", () => {
	const live = metadata();
	delete live.repository;
	for (const field of ["name", "id", "package_type", "visibility"]) {
		const missing = { ...live };
		delete missing[field];
		assert.throws(
			() => validate(missing),
			/package registry validation failed/,
		);
	}
	for (const patch of [
		{ id: 900 },
		{ id: 201 },
		{ name: names[1] },
		{ package_type: "npm" },
		{ visibility: "public" },
		{ visibility: "internal" },
	]) {
		assert.throws(
			() => validate({ ...live, ...patch }),
			/package registry validation failed/,
		);
	}
	const stale = bindings();
	stale.sourceRepository.id = 101;
	const incomplete = bindings();
	incomplete.packages.pop();
	for (const approved of [null, undefined, stale, incomplete]) {
		assert.throws(
			() =>
				validatePackageRegistryManifest(
					live,
					names[0],
					approved,
					runtime,
				),
			/package registry validation failed/,
		);
	}
});
test("accepts an exact disclosed repository identity", () => {
	assert.doesNotThrow(() =>
		validate({
			...metadata(),
			repository: {
				full_name: sourceRepository.fullName,
				id: sourceRepository.id,
			},
		}),
	);
});
test("checks all 28 approved packages", () => {
	for (const entry of bindings().packages) {
		assert.doesNotThrow(() =>
			validate(
				{ ...metadata(), name: entry.name, id: entry.id },
				bindings(),
				runtime,
				entry.name,
			),
		);
	}
});
test("rejects replaced, swapped, missing, or malformed package identity", () => {
	for (const patch of [
		{ id: 900 },
		{ id: 201 },
		{ id: "200" },
		{ id: 0 },
		{ id: null },
		{ id: undefined },
		{ name: names[1] },
		{ name: undefined },
		{ name: "private-app-snapshots/unapproved" },
		{ package_type: "npm" },
		{ package_type: undefined },
		{ visibility: "public" },
		{ visibility: "internal" },
		{ visibility: undefined },
	]) {
		assert.throws(
			() => validate({ ...metadata(), ...patch }),
			/package registry validation failed/,
		);
	}
	for (const live of [null, undefined, [], "private"]) {
		assert.throws(
			() =>
				validatePackageRegistryManifest(
					live,
					names[0],
					bindings(),
					runtime,
				),
			/package registry validation failed/,
		);
	}
	assert.throws(
		() => validate(metadata(), bindings(), runtime, names[1]),
		/package registry validation failed/,
	);
});
test("rejects present undefined or malformed repository disclosure and mismatched repository identity", () => {
	for (const repository of [
		undefined,
		{},
		[],
		"private-app",
		100,
		{ full_name: sourceRepository.fullName },
		{ full_name: sourceRepository.fullName, id: "100" },
		{ full_name: sourceRepository.fullName, id: 101 },
		{ full_name: "example-org/other-app", id: sourceRepository.id },
		{ full_name: null, id: sourceRepository.id },
	]) {
		assert.throws(
			() => validate({ ...metadata(), repository }),
			/package registry validation failed/,
		);
	}
});
test("rejects stale or malformed runtime source identity", () => {
	for (const identity of [
		null,
		{},
		{ ...runtime, fullName: "example-org/other-app" },
		{ ...runtime, id: "101" },
		{ ...runtime, id: "0100" },
		{ ...runtime, id: "100x" },
		{ ...runtime, id: "0" },
		{ ...runtime, id: "9007199254740992" },
		{ ...runtime, id: 100 },
	]) {
		assert.throws(
			() => validate(metadata(), bindings(), identity),
			/package registry validation failed/,
		);
	}
});
test("rejects missing, malformed, incomplete, duplicate, or unexpected bindings", () => {
	const invalid = [
		null,
		undefined,
		[],
		"{}",
		{},
		{ ...bindings(), schemaVersion: "1" },
		{ ...bindings(), sourceRepository: null },
		{ ...bindings(), packages: null },
		{ ...bindings(), packages: bindings().packages.slice(1) },
	];
	for (const source of [
		{ ...sourceRepository, fullName: "example-org/other-app" },
		{ ...sourceRepository, id: 101 },
		{ ...sourceRepository, id: "100" },
		{ ...sourceRepository, id: 0 },
		{ ...sourceRepository, id: Number.MAX_SAFE_INTEGER + 1 },
	]) {
		invalid.push({ ...bindings(), sourceRepository: source });
	}
	for (const patch of [
		{ name: names[1] },
		{ name: "private-app-snapshots/unapproved" },
		{ name: undefined },
		{ id: 201 },
		{ id: "200" },
		{ id: 0 },
		{ id: -1 },
		{ id: 1.5 },
		{ id: Number.MAX_SAFE_INTEGER + 1 },
		{ packageType: "npm" },
		{ packageType: undefined },
	]) {
		const approved = bindings();
		approved.packages[0] = { ...approved.packages[0], ...patch };
		invalid.push(approved);
	}
	invalid.push({
		...bindings(),
		packages: [...bindings().packages, bindings().packages[0]],
	});
	for (const approved of invalid) {
		assert.throws(
			() =>
				validatePackageRegistryManifest(
					metadata(),
					names[0],
					approved,
					runtime,
				),
			/package registry validation failed/,
		);
	}
});
test("rejects invalid source repository names before deriving coordinates", () => {
	for (const fullName of [
		undefined,
		"",
		"private-app",
		"example-org/private-app/extra",
		"../private-app",
		"example-org/..",
		"example org/private-app",
		"example-org/private-app\n",
	]) {
		assert.throws(
			() => expectedPackageNames(fullName),
			/package registry validation failed/,
		);
	}
});
