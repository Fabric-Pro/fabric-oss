import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SNAPSHOT_IMAGES } from "./oss-snapshot-manifest.mjs";
import { planSnapshotRetention } from "./oss-snapshot-retention.mjs";

const fixture = JSON.parse(
	await readFile(
		new URL("./fixtures/oss-snapshot-retention.json", import.meta.url),
		"utf8",
	),
);

function createInput() {
	const packageVersions = SNAPSHOT_IMAGES.map(({ component }) => ({
		component,
		versions: fixture.versions.map(({ key, ...version }) => ({
			...version,
			versionId: `${component}-${key}`,
		})),
	}));
	return {
		now: fixture.now,
		retentionDays: fixture.retentionDays,
		graceDays: fixture.graceDays,
		currentMasterSha: fixture.currentMasterSha,
		completeness: {
			releases: true,
			releaseManifests: true,
			workflowRuns: true,
			packageVersions: true,
			currentMaster: true,
			referrers: true,
		},
		releases: [
			{
				name: "v1.2.3-rc.1",
				state: "published",
				prerelease: true,
				sourceSha: fixture.releaseSha,
				updatedAt: "2026-01-02T00:00:00.000Z",
				manifest: {
					status: "complete",
					images: SNAPSHOT_IMAGES.map(({ component }) => ({
						component,
						digest: fixture.versions.find(
							({ key }) => key === "release",
						).digest,
					})),
				},
			},
		],
		workflowRuns: [
			{
				id: "proof-42",
				status: "queued",
				sourceSha: fixture.proofSha,
				updatedAt: "2026-01-02T00:00:00.000Z",
				digests: [],
			},
		],
		packageVersions,
	};
}

function temporalVersion(plan, versionId, collection) {
	return plan[collection].find(
		(version) => version.versionId === `temporal-worker-${versionId}`,
	);
}

test("an old release-referenced image survives, including for a prerelease", () => {
	const plan = planSnapshotRetention(createInput());
	const version = temporalVersion(plan, "release", "protectedVersions");
	assert.ok(version);
	assert.ok(version.reasons.includes("published-prerelease:v1.2.3-rc.1"));
});

test("an old unreferenced image version is selected by immutable version id and digest", () => {
	const plan = planSnapshotRetention(createInput());
	const version = temporalVersion(
		plan,
		"old-unreferenced",
		"deleteCandidates",
	);
	assert.deepEqual(version, {
		component: "temporal-worker",
		versionId: "temporal-worker-old-unreferenced",
		digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
		tags: ["dddddddddddddddddddddddddddddddddddddddd"],
		reason: "expired-unprotected-image",
	});
	assert.equal(plan.mode, "plan-only");
	assert.equal(plan.deletionEnabled, false);
});

test("the current master SHA survives outside the age window", () => {
	const plan = planSnapshotRetention(createInput());
	const version = temporalVersion(
		plan,
		"current-master",
		"protectedVersions",
	);
	assert.ok(version);
	assert.ok(version.reasons.includes("current-master"));
});

test("an image inside the retention-age window survives", () => {
	const plan = planSnapshotRetention(createInput());
	const version = temporalVersion(plan, "in-window", "protectedVersions");
	assert.ok(version);
	assert.ok(version.reasons.includes("retention-window"));
});

test("a referrer and an untagged package version survive", () => {
	const plan = planSnapshotRetention(createInput());
	const referrer = temporalVersion(plan, "referrer", "protectedVersions");
	const untagged = temporalVersion(plan, "untagged", "protectedVersions");
	assert.ok(referrer.reasons.includes("referrer-version"));
	assert.ok(referrer.reasons.includes("attestation-version"));
	assert.ok(untagged.reasons.includes("untagged-version"));
});

test("a queued proof reference protects all matching SHA-tagged versions", () => {
	const plan = planSnapshotRetention(createInput());
	const version = temporalVersion(plan, "active-proof", "protectedVersions");
	assert.ok(version.reasons.includes("active-proof:proof-42"));
});

test("an active draft protects its source SHA while its manifest is pending", () => {
	const input = createInput();
	input.releases.push({
		name: "v2.0.0-draft",
		state: "draft",
		prerelease: false,
		sourceSha: "dddddddddddddddddddddddddddddddddddddddd",
		updatedAt: "2026-01-02T00:00:00.000Z",
		manifest: { status: "pending" },
	});
	const plan = planSnapshotRetention(input);
	const version = temporalVersion(
		plan,
		"old-unreferenced",
		"protectedVersions",
	);
	assert.ok(version.reasons.includes("active-draft:v2.0.0-draft"));
});

test("a completed proof keeps its source SHA through the grace window", () => {
	const input = createInput();
	input.workflowRuns[0] = {
		id: "proof-43",
		status: "completed",
		sourceSha: "dddddddddddddddddddddddddddddddddddddddd",
		updatedAt: "2026-08-20T00:00:00.000Z",
		digests: [],
	};
	const plan = planSnapshotRetention(input);
	const version = temporalVersion(
		plan,
		"old-unreferenced",
		"protectedVersions",
	);
	assert.ok(version.reasons.includes("proof-grace:proof-43"));
});

test("the planner fails closed when an API protection input is incomplete", () => {
	const input = createInput();
	input.completeness.workflowRuns = false;
	assert.throws(
		() => planSnapshotRetention(input),
		/workflowRuns protection input is incomplete/,
	);
});

test("the planner fails closed when a release manifest lookup failed", () => {
	const input = createInput();
	input.releases[0].manifest = { status: "failed" };
	assert.throws(
		() => planSnapshotRetention(input),
		/has a failed manifest lookup/,
	);
});

test("the planner fails closed when a published manifest omits an image", () => {
	const input = createInput();
	input.releases[0].manifest.images.pop();
	assert.throws(
		() => planSnapshotRetention(input),
		/manifest\.images is missing/,
	);
});

test("the planner fails closed when any snapshot package is missing", () => {
	const input = createInput();
	input.packageVersions.pop();
	assert.throws(
		() => planSnapshotRetention(input),
		/packageVersions is missing/,
	);
});
