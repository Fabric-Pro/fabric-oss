// Planner only: this module performs no network calls and exposes no delete
// operation. A future live collector/executor must prove its API pagination,
// release-manifest inputs, referrer model and deletion semantics separately.

import { pathToFileURL } from "node:url";

import { SNAPSHOT_IMAGES } from "./oss-snapshot-manifest.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const COMPLETE_INPUTS = Object.freeze([
	"releases",
	"releaseManifests",
	"workflowRuns",
	"packageVersions",
	"currentMaster",
	"referrers",
]);
const ACTIVE_PROOF_STATES = new Set(["queued", "in_progress"]);
const RELEASE_STATES = new Set(["published", "draft", "closed"]);
const VERSION_KINDS = new Set(["image", "referrer", "attestation"]);
const EXPECTED_COMPONENTS = new Set(
	SNAPSHOT_IMAGES.map(({ component }) => component),
);

function fail(message) {
	throw new Error(`snapshot retention refused to plan: ${message}`);
}

function requireObject(value, field) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		fail(`${field} must be an object`);
	}
	return value;
}

function requireArray(value, field) {
	if (!Array.isArray(value)) {
		fail(`${field} must be an array`);
	}
	return value;
}

function requireString(value, field) {
	if (typeof value !== "string" || value.length === 0) {
		fail(`${field} must be a non-empty string`);
	}
	return value;
}

function requireSha(value, field) {
	requireString(value, field);
	if (!SHA_RE.test(value)) {
		fail(`${field} must be a full 40-character lowercase SHA`);
	}
	return value;
}

function requireDigest(value, field) {
	requireString(value, field);
	if (!DIGEST_RE.test(value)) {
		fail(`${field} must be a sha256 digest`);
	}
	return value;
}

function requireDate(value, field) {
	requireString(value, field);
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) {
		fail(`${field} must be an ISO timestamp`);
	}
	return timestamp;
}

function requireNonNegativeNumber(value, field) {
	if (!Number.isFinite(value) || value < 0) {
		fail(`${field} must be a non-negative number`);
	}
	return value;
}

function addReason(reasonsByDigest, digest, reason) {
	const reasons = reasonsByDigest.get(digest) ?? new Set();
	reasons.add(reason);
	reasonsByDigest.set(digest, reasons);
}

function addShaReason(reasonsBySha, sha, reason) {
	const reasons = reasonsBySha.get(sha) ?? new Set();
	reasons.add(reason);
	reasonsBySha.set(sha, reasons);
}

function validateCompleteness(completeness) {
	requireObject(completeness, "completeness");
	for (const input of COMPLETE_INPUTS) {
		if (completeness[input] !== true) {
			fail(`${input} protection input is incomplete`);
		}
	}
}

function collectReleaseProtections(
	releases,
	graceCutoff,
	reasonsByDigest,
	reasonsBySha,
) {
	for (const [index, release] of requireArray(
		releases,
		"releases",
	).entries()) {
		const field = `releases[${index}]`;
		requireObject(release, field);
		if (!RELEASE_STATES.has(release.state)) {
			fail(`${field}.state is unsupported`);
		}
		requireString(release.name, `${field}.name`);
		if (typeof release.prerelease !== "boolean") {
			fail(`${field}.prerelease must be a boolean`);
		}
		const sourceSha = requireSha(release.sourceSha, `${field}.sourceSha`);
		const updatedAt = requireDate(release.updatedAt, `${field}.updatedAt`);
		const manifest = requireObject(release.manifest, `${field}.manifest`);

		if (manifest.status === "failed") {
			fail(`${field} has a failed manifest lookup`);
		}
		if (manifest.status !== "complete" && manifest.status !== "pending") {
			fail(`${field}.manifest.status is unsupported`);
		}
		if (release.state === "published" && manifest.status !== "complete") {
			fail(`${field} is published without a complete manifest`);
		}

		const withinGrace = updatedAt >= graceCutoff;
		const protectedRelease =
			release.state === "published" ||
			release.state === "draft" ||
			(release.state === "closed" && withinGrace);
		if (!protectedRelease) {
			continue;
		}

		const reason =
			release.state === "published"
				? release.prerelease === true
					? `published-prerelease:${release.name}`
					: `published-release:${release.name}`
				: release.state === "draft"
					? `active-draft:${release.name}`
					: `draft-grace:${release.name}`;
		addShaReason(reasonsBySha, sourceSha, reason);

		if (manifest.status === "complete") {
			const seenComponents = new Set();
			for (const [imageIndex, image] of requireArray(
				manifest.images,
				`${field}.manifest.images`,
			).entries()) {
				const imageField = `${field}.manifest.images[${imageIndex}]`;
				requireObject(image, imageField);
				const component = requireString(
					image.component,
					`${imageField}.component`,
				);
				if (!EXPECTED_COMPONENTS.has(component)) {
					fail(`${imageField} has unexpected component ${component}`);
				}
				if (seenComponents.has(component)) {
					fail(`${imageField} duplicates component ${component}`);
				}
				seenComponents.add(component);
				addReason(
					reasonsByDigest,
					requireDigest(image.digest, `${imageField}.digest`),
					reason,
				);
			}
			for (const component of EXPECTED_COMPONENTS) {
				if (!seenComponents.has(component)) {
					fail(`${field}.manifest.images is missing ${component}`);
				}
			}
		}
	}
}

function collectProofProtections(
	proofRuns,
	graceCutoff,
	reasonsByDigest,
	reasonsBySha,
) {
	for (const [index, proof] of requireArray(
		proofRuns,
		"workflowRuns",
	).entries()) {
		const field = `workflowRuns[${index}]`;
		requireObject(proof, field);
		const id = requireString(proof.id, `${field}.id`);
		const sourceSha = requireSha(proof.sourceSha, `${field}.sourceSha`);
		const updatedAt = requireDate(proof.updatedAt, `${field}.updatedAt`);
		const active = ACTIVE_PROOF_STATES.has(proof.status);
		if (!active && proof.status !== "completed") {
			fail(`${field}.status is unsupported`);
		}
		if (!active && updatedAt < graceCutoff) {
			continue;
		}
		const reason = active ? `active-proof:${id}` : `proof-grace:${id}`;
		addShaReason(reasonsBySha, sourceSha, reason);
		for (const [digestIndex, digest] of requireArray(
			proof.digests,
			`${field}.digests`,
		).entries()) {
			addReason(
				reasonsByDigest,
				requireDigest(digest, `${field}.digests[${digestIndex}]`),
				reason,
			);
		}
	}
}

function validatePackages(packages) {
	const seenComponents = new Set();

	for (const [packageIndex, packageEntry] of requireArray(
		packages,
		"packageVersions",
	).entries()) {
		const field = `packageVersions[${packageIndex}]`;
		requireObject(packageEntry, field);
		const component = requireString(
			packageEntry.component,
			`${field}.component`,
		);
		if (!EXPECTED_COMPONENTS.has(component)) {
			fail(`${field} has unexpected component ${component}`);
		}
		if (seenComponents.has(component)) {
			fail(`${field} duplicates component ${component}`);
		}
		seenComponents.add(component);

		const seenVersionIds = new Set();
		for (const [versionIndex, version] of requireArray(
			packageEntry.versions,
			`${field}.versions`,
		).entries()) {
			const versionField = `${field}.versions[${versionIndex}]`;
			requireObject(version, versionField);
			const versionId = requireString(
				version.versionId,
				`${versionField}.versionId`,
			);
			if (seenVersionIds.has(versionId)) {
				fail(`${versionField} duplicates versionId ${versionId}`);
			}
			seenVersionIds.add(versionId);
			requireDigest(version.digest, `${versionField}.digest`);
			requireDate(version.createdAt, `${versionField}.createdAt`);
			if (!VERSION_KINDS.has(version.kind)) {
				fail(`${versionField}.kind is unsupported`);
			}
			for (const [tagIndex, tag] of requireArray(
				version.tags,
				`${versionField}.tags`,
			).entries()) {
				requireString(tag, `${versionField}.tags[${tagIndex}]`);
			}
			if (version.subjectDigest !== null) {
				requireDigest(
					version.subjectDigest,
					`${versionField}.subjectDigest`,
				);
			}
		}
	}

	for (const component of EXPECTED_COMPONENTS) {
		if (!seenComponents.has(component)) {
			fail(`packageVersions is missing ${component}`);
		}
	}
}

export function planSnapshotRetention(input) {
	requireObject(input, "input");
	validateCompleteness(input.completeness);
	const now = requireDate(input.now, "now");
	const retentionDays = requireNonNegativeNumber(
		input.retentionDays,
		"retentionDays",
	);
	const graceDays = requireNonNegativeNumber(input.graceDays, "graceDays");
	const currentMasterSha = requireSha(
		input.currentMasterSha,
		"currentMasterSha",
	);
	validatePackages(input.packageVersions);

	const ageCutoff = now - retentionDays * DAY_MS;
	const graceCutoff = now - graceDays * DAY_MS;
	const reasonsByDigest = new Map();
	const reasonsBySha = new Map();
	addShaReason(reasonsBySha, currentMasterSha, "current-master");

	collectReleaseProtections(
		input.releases,
		graceCutoff,
		reasonsByDigest,
		reasonsBySha,
	);
	collectProofProtections(
		input.workflowRuns,
		graceCutoff,
		reasonsByDigest,
		reasonsBySha,
	);

	const protectedVersions = [];
	const deleteCandidates = [];
	for (const packageEntry of input.packageVersions) {
		for (const version of packageEntry.versions) {
			const reasons = new Set(reasonsByDigest.get(version.digest) ?? []);
			for (const tag of version.tags) {
				for (const reason of reasonsBySha.get(tag) ?? []) {
					reasons.add(reason);
				}
			}
			if (Date.parse(version.createdAt) >= ageCutoff) {
				reasons.add("retention-window");
			}
			if (version.tags.length === 0) {
				reasons.add("untagged-version");
			}
			if (version.kind === "referrer" || version.subjectDigest !== null) {
				reasons.add("referrer-version");
			}
			if (version.kind === "attestation") {
				reasons.add("attestation-version");
			}

			const record = {
				component: packageEntry.component,
				versionId: version.versionId,
				digest: version.digest,
				tags: [...version.tags],
			};
			if (reasons.size > 0) {
				protectedVersions.push({
					...record,
					reasons: [...reasons].sort(),
				});
			} else {
				deleteCandidates.push({
					...record,
					reason: "expired-unprotected-image",
				});
			}
		}
	}

	return {
		mode: "plan-only",
		deletionEnabled: false,
		generatedAt: new Date(now).toISOString(),
		ageCutoff: new Date(ageCutoff).toISOString(),
		graceCutoff: new Date(graceCutoff).toISOString(),
		protectedVersions,
		deleteCandidates,
	};
}

async function main() {
	if (process.argv.length !== 3) {
		fail("usage: node oss-snapshot-retention.mjs <input.json>");
	}
	const { readFile } = await import("node:fs/promises");
	const input = JSON.parse(await readFile(process.argv[2], "utf8"));
	process.stdout.write(
		`${JSON.stringify(planSnapshotRetention(input), null, 2)}\n`,
	);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
