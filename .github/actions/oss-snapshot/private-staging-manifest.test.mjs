import assert from "node:assert/strict";
import test from "node:test";
import {
	createAggregateManifest,
	SNAPSHOT_IMAGES,
} from "./oss-snapshot-manifest.mjs";

import * as implementation from "./private-staging-manifest.mjs";

const expected = {
	repository: "Fabric-Pro/fabric-dev",
	sourceSha: "a".repeat(40),
	sourceRef: "refs/heads/staging",
	workflowRef:
		"Fabric-Pro/fabric-dev/.github/workflows/private-staging-images.yml@refs/heads/staging",
	serverUrl: "https://github.com",
};
function fragments(identity = expected) {
	return SNAPSHOT_IMAGES.map(({ component, dockerfile }) => ({
		schemaVersion: "1.0.0",
		component,
		dockerfile,
		context: ".",
		image: `ghcr.io/fabric-pro/fabric-dev-snapshots/${component}`,
		tag: identity.sourceSha,
		digest: `sha256:${"b".repeat(64)}`,
		sourceSha: identity.sourceSha,
		sourceRef: identity.sourceRef,
		sourceRepository: identity.repository,
		buildWorkflow: identity.workflowRef,
		signerWorkflow: `${identity.repository}/.github/workflows/private-staging-images.yml`,
		labels: {
			"org.opencontainers.image.source": `${identity.serverUrl}/${identity.repository}`,
			"org.opencontainers.image.revision": identity.sourceSha,
		},
		attestations: {
			provenance: "https://slsa.dev/provenance/v1",
			sbom: "https://spdx.dev/Document/v2.3",
		},
	}));
}
test("private staging has a separate complete provenance-bound image set", () => {
	assert.equal(typeof implementation.createPrivateManifest, "function");
	const result = implementation.createPrivateManifest(fragments(), expected);
	assert.equal(result.kind, "fabric-private-staging-snapshot-set");
	assert.equal(result.images.length, 14);
});
test("private images cannot pass the public snapshot validator", () => {
	assert.throws(
		() => createAggregateManifest(fragments(), expected),
		/unexpected image coordinates/,
	);
});
test("private policy rejects public namespaces and arbitrary source branches", () => {
	assert.equal(typeof implementation.createPrivateManifest, "function");
	const bad = fragments();
	bad[0].image = bad[0].image.replace(
		"fabric-dev-snapshots",
		"fabric-oss-snapshots",
	);
	assert.throws(
		() => implementation.createPrivateManifest(bad, expected),
		/unexpected image coordinates/,
	);
	for (const sourceRef of [
		"refs/heads/master",
		"refs/heads/feature/example",
		"refs/heads/promotion/",
		"refs/tags/v1.0.0",
	]) {
		assert.throws(
			() =>
				implementation.createPrivateManifest(fragments(), {
					...expected,
					sourceRef,
				}),
			/private source identity/,
		);
	}
});
test("promotion candidate manifest binds the full protected ref and workflow", () => {
	assert.equal(typeof implementation.createPrivateManifest, "function");
	const identity = {
		...expected,
		sourceRef: "refs/heads/promotion/example-cycle",
		workflowRef:
			"Fabric-Pro/fabric-dev/.github/workflows/private-staging-images.yml@refs/heads/promotion/example-cycle",
	};
	assert.equal(
		implementation.createPrivateManifest(fragments(identity), identity)
			.sourceRef,
		identity.sourceRef,
	);
	assert.throws(
		() =>
			implementation.createPrivateManifest(fragments(identity), {
				...identity,
				workflowRef: expected.workflowRef,
			}),
		/private source identity/,
	);
});
