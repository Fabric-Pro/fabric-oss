import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SNAPSHOT_IMAGES } from "./oss-snapshot-manifest.mjs";

function fail(message) {
	throw new Error(`package registry validation failed: ${message}`);
}
function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isId(value) {
	return Number.isSafeInteger(value) && value > 0;
}

export function expectedPackageNames(fullName) {
	if (
		typeof fullName !== "string" ||
		!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(fullName)
	) {
		fail("source repository must be an owner/repository name");
	}
	const repositoryName = fullName.split("/")[1].toLowerCase();
	return ["snapshots", "buildcache"].flatMap((suffix) =>
		SNAPSHOT_IMAGES.map(
			({ component }) => `${repositoryName}-${suffix}/${component}`,
		),
	);
}

export function validatePackageRegistryManifest(
	metadata,
	expectedName,
	bindings,
	runtime,
) {
	const expectedNames = new Set(expectedPackageNames(runtime?.fullName));
	if (
		typeof runtime?.id !== "string" ||
		!/^[1-9][0-9]*$/.test(runtime.id) ||
		!isId(Number(runtime.id))
	) {
		fail(
			"runtime source repository ID must be a positive safe integer string",
		);
	}
	if (
		!isObject(bindings) ||
		bindings.schemaVersion !== 1 ||
		!isObject(bindings.sourceRepository) ||
		bindings.sourceRepository.fullName !== runtime.fullName ||
		!isId(bindings.sourceRepository.id) ||
		bindings.sourceRepository.id !== Number(runtime.id)
	) {
		fail(
			"administrative bindings do not match the runtime source repository",
		);
	}
	if (
		!Array.isArray(bindings.packages) ||
		bindings.packages.length !== expectedNames.size
	) {
		fail(
			"administrative bindings must contain the complete expected package set",
		);
	}
	const approved = new Map();
	const ids = new Set();
	for (const entry of bindings.packages) {
		if (
			!isObject(entry) ||
			!expectedNames.has(entry.name) ||
			entry.packageType !== "container" ||
			!isId(entry.id) ||
			approved.has(entry.name) ||
			ids.has(entry.id)
		) {
			fail(
				"administrative package binding is invalid, unexpected, or duplicated",
			);
		}
		approved.set(entry.name, entry.id);
		ids.add(entry.id);
	}
	if (!approved.has(expectedName)) {
		fail("requested package is outside the approved package set");
	}
	if (
		!isObject(metadata) ||
		metadata.name !== expectedName ||
		metadata.package_type !== "container" ||
		metadata.id !== approved.get(expectedName) ||
		metadata.visibility !== "private"
	) {
		fail(
			"live package identity or private visibility does not match its approved binding",
		);
	}
	// GITHUB_TOKEN can omit the linked repository or return an explicit null. Only the
	// complete administrator-approved ID binding permits that undisclosed link.
	if (
		!Object.hasOwn(metadata, "repository") ||
		metadata.repository === null
	) {
		return;
	}
	if (
		!isObject(metadata.repository) ||
		metadata.repository.full_name !== runtime.fullName ||
		metadata.repository.id !== bindings.sourceRepository.id
	) {
		fail(
			"live package repository disclosure does not match the source repository",
		);
	}
}

function main() {
	if (process.argv.length !== 3) {
		fail("expected exactly one package name argument");
	}
	let metadata;
	let bindings;
	try {
		metadata = JSON.parse(readFileSync(0, "utf8"));
		bindings = JSON.parse(process.env.PRIVATE_STAGING_PACKAGE_BINDINGS);
	} catch {
		fail("live metadata and administrative bindings must be valid JSON");
	}
	validatePackageRegistryManifest(metadata, process.argv[2], bindings, {
		fullName: process.env.SOURCE_REPOSITORY,
		id: process.env.SOURCE_REPOSITORY_ID,
	});
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		main();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
