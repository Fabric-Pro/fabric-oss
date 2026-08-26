import assert from "node:assert/strict";
import test from "node:test";

import {
	createAggregateManifest,
	SNAPSHOT_IMAGES,
	SNAPSHOT_NAMESPACE,
	SNAPSHOT_WORKFLOW,
} from "./oss-snapshot-manifest.mjs";

const expected = {
	repository: "Fabric-Pro/fabric-oss",
	sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	sourceRef: "refs/heads/master",
	workflowRef:
		"Fabric-Pro/fabric-oss/.github/workflows/oss-snapshot-images.yml@refs/heads/master",
	serverUrl: "https://github.com",
};

function digestFor(index) {
	return `sha256:${(index + 1).toString(16).padStart(64, "0")}`;
}

function createFragments() {
	return SNAPSHOT_IMAGES.map(({ component, dockerfile }, index) => ({
		schemaVersion: "1.0.0",
		component,
		dockerfile,
		context: ".",
		image: `${SNAPSHOT_NAMESPACE}/${component}`,
		tag: expected.sourceSha,
		digest: digestFor(index),
		sourceSha: expected.sourceSha,
		sourceRef: expected.sourceRef,
		sourceRepository: expected.repository,
		buildWorkflow: expected.workflowRef,
		signerWorkflow: `${expected.repository}/${SNAPSHOT_WORKFLOW}`,
		labels: {
			"org.opencontainers.image.source":
				"https://github.com/Fabric-Pro/fabric-oss",
			"org.opencontainers.image.revision": expected.sourceSha,
		},
		attestations: {
			provenance: "https://slsa.dev/provenance/v1",
			sbom: "https://spdx.dev/Document/v2.3",
		},
	}));
}

test("aggregates exactly the 14 expected source-bound snapshot images", () => {
	const manifest = createAggregateManifest(createFragments(), expected);
	assert.equal(manifest.images.length, 14);
	assert.deepEqual(
		manifest.images.map(({ component }) => component).sort(),
		SNAPSHOT_IMAGES.map(({ component }) => component).sort(),
	);
	assert.equal(manifest.sourceSha, expected.sourceSha);
	assert.ok(
		manifest.images.every(
			(image) =>
				image.labels["org.opencontainers.image.source"] ===
				"https://github.com/Fabric-Pro/fabric-oss",
		),
	);
});

test("fails closed if a component fragment is missing", () => {
	assert.throws(
		() => createAggregateManifest(createFragments().slice(1), expected),
		/expected 14 fragments, received 13/,
	);
});

test("fails closed if GHCR package linkage points at a different repository", () => {
	const fragments = createFragments();
	fragments[0].labels["org.opencontainers.image.source"] =
		"https://github.com/example/other";
	assert.throws(
		() => createAggregateManifest(fragments, expected),
		/unexpected OCI source labels/,
	);
});

test("fails closed if a digest is paired with a different source SHA", () => {
	const fragments = createFragments();
	fragments[0].sourceSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
	assert.throws(
		() => createAggregateManifest(fragments, expected),
		/unexpected source identity/,
	);
});
