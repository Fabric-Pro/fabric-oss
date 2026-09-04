import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	SNAPSHOT_IMAGES,
	SNAPSHOT_NAMESPACE,
} from "./oss-snapshot-manifest.mjs";

const workflow = await readFile(
	new URL("../../workflows/oss-snapshot-images.yml", import.meta.url),
	"utf8",
);

test("the workflow builds exactly the required 14-image matrix", () => {
	const matrixEntries = [
		...workflow.matchAll(/- component: ([^\n]+)\n\s+dockerfile: ([^\n]+)/g),
	].map(([, component, dockerfile]) => ({
		component: component.trim(),
		dockerfile: dockerfile.trim(),
	}));
	assert.deepEqual(matrixEntries, SNAPSHOT_IMAGES);
	assert.equal(matrixEntries.length, 14);
	assert.equal(
		[...workflow.matchAll(/uses: docker\/build-push-action@/g)].length,
		1,
	);
	assert.match(
		workflow,
		/\n {2}build:\n {4}name: Build and attest[^\n]+\n {4}needs: policy-tests/,
	);
});

test("master and proof dispatch have no path-filter or cancellation escape hatch", () => {
	assert.match(workflow, /push:\n\s+branches: \[master\]/);
	assert.match(workflow, /workflow_dispatch:/);
	assert.doesNotMatch(workflow, /^\s+paths(?:-ignore)?:/m);
	assert.doesNotMatch(workflow, /^concurrency:/m);
	assert.doesNotMatch(workflow, /cancel-in-progress:\s*true/);
});

test("every job is fail-closed to the canonical public repository", () => {
	const guards = [
		...workflow.matchAll(
			/if: github\.repository == 'Fabric-Pro\/fabric-oss'/g,
		),
	];
	assert.equal(guards.length, 3);
});

test("every action reference is pinned to an exact commit", () => {
	const actionReferences = [...workflow.matchAll(/uses:\s*([^\s#]+)/g)].map(
		([, reference]) => reference,
	);
	assert.ok(actionReferences.length > 0);
	for (const reference of actionReferences) {
		assert.match(reference, /@[0-9a-f]{40}$/);
	}
});

test("the build uses only full-SHA private snapshot coordinates and source linkage", () => {
	assert.match(
		workflow,
		new RegExp(SNAPSHOT_NAMESPACE.replaceAll("/", "\\/")),
	);
	assert.match(
		workflow,
		/tags: \$\{\{ env\.IMAGE_NAME \}\}:\$\{\{ github\.sha \}\}/,
	);
	assert.doesNotMatch(workflow, /(?:^|:)latest(?:$|\s)/m);
	assert.match(
		workflow,
		/org\.opencontainers\.image\.source=\$\{\{ env\.SOURCE_URL \}\}/,
	);
	assert.match(workflow, /org\.opencontainers\.image\.revision=/);
	assert.match(workflow, /context: \./);
	const runners = [...workflow.matchAll(/runs-on: ([^\n]+)/g)].map(
		([, runner]) => runner.trim(),
	);
	assert.deepEqual(runners, [
		"ubuntu-latest",
		"ubuntu-latest",
		"ubuntu-latest",
	]);
});

test("the layer cache lives in the registry, not the shared Actions cache", () => {
	// Fourteen mode=max caches exceed the repository's 10 GB Actions cache and
	// evict the caches pull-request jobs depend on. See CACHE_NAMESPACE.
	assert.doesNotMatch(workflow, /type=gha/);
	const cacheRef =
		"\\$\\{\\{ env\\.CACHE_NAMESPACE \\}\\}\\/\\$\\{\\{ matrix\\.component \\}\\}:master";
	assert.match(
		workflow,
		new RegExp(`cache-from: type=registry,ref=${cacheRef}\\n`),
	);
	assert.match(
		workflow,
		new RegExp(
			`cache-to: type=registry,ref=${cacheRef},mode=max,ignore-error=true\\n`,
		),
	);
	assert.match(
		workflow,
		/^ {2}CACHE_NAMESPACE: ghcr\.io\/fabric-pro\/fabric-oss-buildcache$/m,
	);
	// The env context is not available in a job's env block; a job-level
	// CACHE_IMAGE derived from it made every master build fail to parse.
	assert.doesNotMatch(workflow, /^ {6}CACHE_IMAGE:/m);
});

test("permissions are limited to repository read and snapshot publication", () => {
	assert.doesNotMatch(workflow, /^\s+contents: write/m);
	assert.doesNotMatch(workflow, /^\s+actions:/m);
	for (const permission of [
		"contents: read",
		"packages: write",
		"id-token: write",
		"attestations: write",
	]) {
		assert.ok(
			workflow.includes(permission),
			`missing permission ${permission}`,
		);
	}
});

test("attestation verification binds repository, workflow, source ref and SHA", () => {
	for (const option of [
		"--repo",
		"--signer-workflow",
		"--source-digest",
		"--source-ref",
		"--deny-self-hosted-runners",
	]) {
		assert.ok(
			workflow.includes(option),
			`missing verifier option ${option}`,
		);
	}
	assert.match(workflow, /push-to-registry: true/);
	assert.match(workflow, /uses: actions\/attest@[0-9a-f]{40}/);
	assert.doesNotMatch(workflow, /uses: actions\/attest-sbom@/);
	assert.equal(
		[...workflow.matchAll(/create-storage-record: false/g)].length,
		2,
	);
	assert.match(
		workflow,
		/sbom-path: \$\{\{ matrix\.component \}\}\.spdx\.json/,
	);
});

test("SBOM scans use the authenticated registry without duplicating local images", () => {
	assert.match(workflow, /docker buildx prune --all --force/);
	assert.match(
		workflow,
		/image: \$\{\{ env\.IMAGE_NAME \}\}@\$\{\{ steps\.build\.outputs\.digest \}\}/,
	);
	assert.doesNotMatch(workflow, /image: registry:/);
	assert.match(workflow, /registry-username: \$\{\{ github\.actor \}\}/);
	assert.match(
		workflow,
		/registry-password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/,
	);
	assert.ok(
		workflow.indexOf("docker buildx prune --all --force") <
			workflow.indexOf("registry-username:"),
	);
});

test("matrix evidence is temporary while complete evidence is retained", () => {
	assert.match(workflow, /name: oss-snapshot-part-[\s\S]+?retention-days: 1/);
	assert.match(
		workflow,
		/name: oss-snapshot-manifest-[\s\S]+?retention-days: 90/,
	);
});

test("retention remains a tested planner with no live or destructive job", () => {
	assert.match(
		workflow,
		/run: node --test \.github\/actions\/oss-snapshot\/oss-snapshot-\*\.test\.mjs/,
	);
	assert.doesNotMatch(workflow, /deletePackageVersion|method:\s*DELETE/);
	assert.doesNotMatch(workflow, /^\s+schedule:/m);
});
